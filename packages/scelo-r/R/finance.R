# Finance: discount curves, present values, yield-curve models.
#
# sc_discount_curve() is the IDE's discount-curve table (linear interpolation
# between quoted tenors, flat extrapolation); sc_smith_wilson() is the EIOPA
# extrapolation to the UFR it points at; sc_nelson_siegel() / sc_nss() fit
# the parametric curves; sc_hull_white() simulates short-rate paths. The
# scalar helpers (sc_pv, sc_npv, sc_irr, sc_annuity_certain, sc_duration ...)
# are the Exam-FM toolkit in vectorised form. The one-line rate conversions
# of scelo.finance (sc_nominal, sc_effective, sc_force, sc_from_force,
# sc_discount_rate) live in extras.R with the other cross-module one-liners.
#
# A curve is given in one of four shapes: a flat rate (0.04), a named numeric
# vector of zero rates by tenor (c(`1` = 0.03, `5` = 0.04)), a list of
# c(tenor, rate) pairs (or a two-column matrix), or a data frame with tenor
# and rate columns (inferred by alias); percent quotes (max > 1) in the last
# two shapes are divided by 100, exactly as the Python package does.

# ── scalar time-value helpers ──────────────────────────────────────────────

#' Discount factor
#'
#' v^t = (1+i)^(−t).
#' @param i Effective annual rate.
#' @param t Time(s) in years.
#' @return Discount factor(s).
#' @examples
#' sc_v(0.05, 1:3)
#' @export
sc_v <- function(i, t = 1) (1 + i)^-as.numeric(t)

#' Present value and net present value
#'
#' `sc_pv()` discounts cash flows at `times` (default 1, 2, ...) under a flat
#' rate or a curve (zero rates by tenor, any shape [sc_discount_curve()]
#' accepts). `sc_npv()` discounts a stream starting at time 0 (`t0 = TRUE`,
#' Excel-unlike) or time 1 at a flat rate.
#' @param cashflows Cash flows.
#' @param rate A flat effective annual rate or a curve (see [sc_discount_curve()]).
#' @param times Payment times (default 1, 2, ...).
#' @param t0 Whether the first cash flow is at time 0.
#' @return A number.
#' @examples
#' sc_pv(rep(100, 5), 0.05)
#' sc_npv(0.1, c(-100, 60, 60))
#' @export
sc_pv <- function(cashflows, rate, times = NULL) {
  cf <- as.numeric(cashflows)
  t <- if (is.null(times)) seq_along(cf) else as.numeric(times)
  sum(cf * sc_zero_to_df(.sc_zero_at(rate, t), t))
}

#' @rdname sc_pv
#' @export
sc_npv <- function(rate, cashflows, t0 = TRUE) {
  cf <- as.numeric(cashflows)
  t <- seq_along(cf) - if (t0) 1 else 0
  sum(cf * (1 + rate)^-t)
}

#' Internal rate of return
#'
#' Bisection on NPV(t0) = 0; errors when there is no sign change in `[lo, hi]`.
#' @param cashflows Cash flows starting at time 0.
#' @param lo,hi Bracket.
#' @param tol Tolerance on NPV and on the bracket width.
#' @return The rate.
#' @examples
#' sc_irr(c(-100, 60, 60))
#' @export
sc_irr <- function(cashflows, lo = -0.99, hi = 10, tol = 1e-10) {
  f_lo <- sc_npv(lo, cashflows)
  f_hi <- sc_npv(hi, cashflows)
  if (f_lo * f_hi > 0) stop("IRR not bracketed: NPV has the same sign at both ends", call. = FALSE)
  for (k in seq_len(200)) {
    mid <- (lo + hi) / 2
    f_mid <- sc_npv(mid, cashflows)
    if (abs(f_mid) < tol || (hi - lo) < tol) return(mid)
    if (f_lo * f_mid < 0) {
      hi <- mid
      f_hi <- f_mid
    } else {
      lo <- mid
      f_lo <- f_mid
    }
  }
  (lo + hi) / 2
}

#' Annuities-certain and accumulations
#'
#' `sc_annuity_certain()` gives a^(m)_n (immediate) or ä_n (`due`);
#' `increasing` gives (Ia)_n / (Iä)_n. `sc_accumulation()` gives s_n or s̈_n.
#' @param n Term in years (may be a vector).
#' @param i Effective annual rate.
#' @param due Annuity-due (`TRUE`) or immediate.
#' @param m Payments per year.
#' @param increasing Arithmetically increasing annuity.
#' @return A number (or vector, one per `n`).
#' @examples
#' sc_annuity_certain(10, 0.05)
#' sc_annuity_certain(10, 0.05, due = TRUE)
#' sc_annuity_certain(10, 0.05, increasing = TRUE)
#' sc_accumulation(10, 0.05)
#' @export
sc_annuity_certain <- function(n, i, due = FALSE, m = 1, increasing = FALSE) {
  if (i == 0) return(if (increasing) n * (n + 1) / 2 else as.numeric(n))
  vv <- 1 / (1 + i)
  if (increasing) {
    a_due <- (1 - vv^n) / (i / (1 + i))
    ia <- (a_due - n * vv^n) / i  # (Ia)_n immediate
    return(if (due) ia * (1 + i) else ia)
  }
  i_m <- m * ((1 + i)^(1 / m) - 1)
  d_m <- m * (1 - vv^(1 / m))
  (1 - vv^n) / (if (due) d_m else i_m)
}

#' @rdname sc_annuity_certain
#' @export
sc_accumulation <- function(n, i, due = FALSE) sc_annuity_certain(n, i, due) * (1 + i)^n

#' Duration and convexity
#'
#' Macaulay (or `modified`) duration and convexity Σ t(t+1)·CF·v^(t+2) / P
#' of a cash-flow stream at a flat annual rate.
#' @param cashflows Cash flows.
#' @param rate Effective annual rate.
#' @param times Payment times (default 1, 2, ...).
#' @param modified Modified duration (Macaulay / (1 + rate)).
#' @return A number.
#' @examples
#' sc_duration(c(rep(5, 9), 105), 0.05)
#' sc_convexity(c(rep(5, 9), 105), 0.05)
#' @export
sc_duration <- function(cashflows, rate, times = NULL, modified = FALSE) {
  cf <- as.numeric(cashflows)
  t <- if (is.null(times)) seq_along(cf) else as.numeric(times)
  disc <- (1 + rate)^-t
  p <- sum(cf * disc)
  mac <- sum(t * cf * disc) / p
  if (modified) mac / (1 + rate) else mac
}

#' @rdname sc_duration
#' @export
sc_convexity <- function(cashflows, rate, times = NULL) {
  cf <- as.numeric(cashflows)
  t <- if (is.null(times)) seq_along(cf) else as.numeric(times)
  p <- sum(cf * (1 + rate)^-t)
  sum(t * (t + 1) * cf * (1 + rate)^-(t + 2)) / p
}

#' Bond price and yield
#'
#' `sc_bond_price()` prices a bond paying coupon rate `coupon` `m` times a
#' year for `n` years at nominal yield `yield` (compounded m-thly);
#' `sc_bond_yield()` solves the nominal yield for a price by bisection.
#' @param face Face value.
#' @param coupon Annual coupon rate.
#' @param n Term in years.
#' @param yield Nominal annual yield, compounded `m`-thly.
#' @param m Coupons per year.
#' @param redemption Redemption amount (default `face`).
#' @param price Market price.
#' @return A number.
#' @examples
#' sc_bond_price(100, 0.05, 10, 0.05)
#' sc_bond_yield(95, 100, 0.05, 10)
#' @export
sc_bond_price <- function(face, coupon, n, yield, m = 1, redemption = NULL) {
  C <- face * coupon / m
  j <- yield / m
  N <- n * m
  R <- if (is.null(redemption)) face else redemption
  if (j != 0) C * (1 - (1 + j)^-N) / j + R * (1 + j)^-N else C * N + R
}

#' @rdname sc_bond_price
#' @export
sc_bond_yield <- function(price, face, coupon, n, m = 1, redemption = NULL) {
  lo <- -0.5
  hi <- 5
  for (k in seq_len(200)) {
    mid <- (lo + hi) / 2
    if (sc_bond_price(face, coupon, n, mid, m, redemption) > price) lo <- mid else hi <- mid
  }
  (lo + hi) / 2
}

# ── curves ──────────────────────────────────────────────────────────────────

.SC_CURVE_SHAPES <- "curve must be a flat rate, a named vector of rates by tenor, a list of c(tenor, rate) pairs or a data frame with tenor and rate columns"

.sc_is_flat_rate <- function(curve) is.numeric(curve) && length(curve) == 1 && is.null(names(curve))

# Quoted points of a curve: list(t = tenors (sorted), r = rates, label).
.sc_curve_points <- function(curve = NULL, df = NULL) {
  if (is.null(curve) && is.null(df)) return(list(t = 1, r = 0.04, label = "flat 4 %"))
  if (.sc_is_flat_rate(curve)) return(list(t = 1, r = as.numeric(curve), label = sprintf("flat %s %%", .sc_gnum(curve * 100))))
  if (is.numeric(curve) && !is.null(names(curve))) {
    t <- suppressWarnings(as.numeric(names(curve)))
    if (anyNA(t)) stop("the names of a curve vector must be numeric tenors", call. = FALSE)
    o <- order(t)
    return(list(t = t[o], r = as.numeric(curve)[o], label = sprintf("%d quoted tenors", length(t))))
  }
  if (is.data.frame(curve) || !is.null(df)) {
    d <- if (is.data.frame(curve)) curve else df
    tc <- sc_infer(d, "tenor")
    rc <- sc_infer(d, "rate", exclude = tc)
    t <- .sc_as_num(d[[tc]])
    r <- .sc_as_num(d[[rc]])
    ok <- !is.na(t) & !is.na(r)
    if (!any(ok)) stop(sprintf("no numeric (tenor, rate) pairs in `%s` / `%s`", tc, rc), call. = FALSE)
    g <- tapply(r[ok], t[ok], mean)
    rr <- as.numeric(g)
    if (max(rr) > 1) rr <- rr / 100
    return(list(t = as.numeric(names(g)), r = rr, label = sprintf("`%s` by `%s`", rc, tc)))
  }
  if (is.numeric(curve)) stop(.SC_CURVE_SHAPES, call. = FALSE)
  pts <- if (is.matrix(curve)) curve else if (is.list(curve)) do.call(rbind, lapply(curve, function(p) as.numeric(p)[1:2])) else NULL
  if (is.null(pts) || !is.numeric(pts) || ncol(pts) != 2 || anyNA(pts)) stop(.SC_CURVE_SHAPES, call. = FALSE)
  o <- order(pts[, 1])
  t <- pts[o, 1]
  r <- pts[o, 2]
  if (max(r) > 1) r <- r / 100
  list(t = t, r = r, label = sprintf("%d quoted tenors", length(t)))
}

# Zero rate at times t: linear between quoted tenors, flat beyond.
.sc_zero_at <- function(curve, t) {
  pts <- .sc_curve_points(curve)
  if (length(pts$t) == 1) return(rep(pts$r[1], length(t)))
  stats::approx(pts$t, pts$r, xout = as.numeric(t), rule = 2, ties = mean)$y
}

#' Zero rates and discount factors
#'
#' `sc_zero_to_df()` gives the discount factor of an annual-compound zero
#' rate, (1+z)^(−t); `sc_df_to_zero()` the zero rate of a discount factor,
#' p^(−1/t) − 1.
#' @param z Zero rate(s).
#' @param p Discount factor(s).
#' @param t Tenor(s).
#' @return A numeric vector.
#' @examples
#' sc_zero_to_df(0.05, 1:3)
#' sc_df_to_zero(0.9, 2)
#' @export
sc_zero_to_df <- function(z, t) (1 + as.numeric(z))^-as.numeric(t)

#' @rdname sc_zero_to_df
#' @export
sc_df_to_zero <- function(p, t) as.numeric(p)^(-1 / as.numeric(t)) - 1

#' Discount-curve table
#'
#' Tenor, zero rate, discount factor, 1y forward and annuity-certain a_n for
#' t = 1 ... `max_tenor`. `curve` is a flat rate, a named vector of rates by
#' tenor, a list of `c(tenor, rate)` pairs or a data frame with tenor + rate
#' columns (percent values are divided by 100); or pass the data frame as
#' `df`. Linear interpolation between quoted tenors, flat extrapolation
#' beyond the last (use [sc_smith_wilson()] for a UFR).
#' @param curve The curve (see Details), or `NULL` for a flat 4 %.
#' @param df A data frame with tenor and rate columns (inferred by alias).
#' @param max_tenor Last tenor (default: 30, or the last quoted tenor if later).
#' @return A `scelo_table`.
#' @examples
#' sc_discount_curve(0.05, max_tenor = 10)
#' sc_discount_curve(c(`1` = 0.03, `5` = 0.04, `10` = 0.05), max_tenor = 12)
#' sc_discount_curve(data.frame(tenor = c(1, 2), rate = c(3, 4)), max_tenor = 2)
#' @export
sc_discount_curve <- function(curve = NULL, df = NULL, max_tenor = NULL) {
  .sc_tool("sc_discount_curve", Filter(Negate(is.null), list(curve = curve, max_tenor = max_tenor)), if (is.data.frame(curve)) curve else df, {
    pts <- .sc_curve_points(curve, df)
    t <- pts$t
    r <- pts$r
    notes <- character()
    if (length(t) == 1 && (is.null(curve) || .sc_is_flat_rate(curve))) notes <- sprintf("Flat %s %% curve: every tenor discounts at the same rate.", .sc_gnum(r[1] * 100))
    mt <- if (isTRUE(max_tenor > 0)) as.integer(max_tenor) else as.integer(max(30, max(round(t))))
    tenors <- seq_len(mt)
    z <- if (length(t) == 1) rep(r[1], mt) else stats::approx(t, r, xout = as.numeric(tenors), rule = 2, ties = mean)$y
    dfs <- (1 + z)^-tenors
    prev <- c(1, dfs[-mt])
    fwd <- prev / dfs - 1
    ann <- cumsum(dfs)
    out <- data.frame(tenor = tenors, `zero rate` = z, `discount factor` = dfs, `1y forward` = fwd, `annuity-certain a_n` = ann, check.names = FALSE)
    notes <- c(notes, "Zero rates are annual-compound; linear interpolation between quoted tenors and flat extrapolation beyond the last one (use sc_smith_wilson for a UFR extrapolation). v_t = (1+z_t)^−t; f(t−1,t) = v_{t−1}/v_t − 1; a_n = Σ v_t.")
    sc_table(out, title = sprintf("Discount curve · %s · to %dy", pts$label, mt), basis = pts$label, notes = notes, stage = "hard")
  })
}

#' Forward rates from zero rates
#'
#' One-period forward rates implied by annual-compound zero rates.
#' @param zeros Zero rates.
#' @param tenors Their tenors (default 1, 2, ...).
#' @return A named numeric vector (names: tenors).
#' @examples
#' sc_forward_rates(c(0.03, 0.035, 0.04))
#' @export
sc_forward_rates <- function(zeros, tenors = NULL) {
  z <- as.numeric(zeros)
  t <- if (is.null(tenors)) as.numeric(seq_along(z)) else as.numeric(tenors)
  p <- (1 + z)^-t
  prev <- c(1, p[-length(p)])
  tprev <- c(0, t[-length(t)])
  stats::setNames((prev / p)^(1 / (t - tprev)) - 1, t)
}

#' Zero rates bootstrapped from par rates
#'
#' Annual par (swap / coupon) rates at integer tenors 1..n to zero rates.
#' @param par Par rates.
#' @param tenors Their tenors (default 1, 2, ...).
#' @return A named numeric vector of zero rates (names: tenors).
#' @examples
#' sc_bootstrap_par(c(0.03, 0.035, 0.04))
#' @export
sc_bootstrap_par <- function(par, tenors = NULL) {
  c_ <- as.numeric(par)
  t <- if (is.null(tenors)) seq_along(c_) else as.integer(tenors)
  dfs <- numeric(length(c_))
  for (k in seq_along(c_)) dfs[k] <- (1 - c_[k] * sum(dfs[seq_len(k - 1)])) / (1 + c_[k])
  stats::setNames(dfs^(-1 / t) - 1, t)
}

# ── Smith–Wilson (EIOPA) ──────────────────────────────────────────────────

.sc_wilson <- function(t, u, alpha, omega) {
  mn <- outer(t, u, pmin)
  mx <- outer(t, u, pmax)
  exp(-omega * outer(t, u, "+")) * (alpha * mn - 0.5 * exp(-alpha * mx) * (exp(alpha * mn) - exp(-alpha * mn)))
}

#' Smith–Wilson extrapolation (EIOPA)
#'
#' Fit the observed zero (or par) rates exactly and extrapolate to the
#' ultimate forward rate. `ufr` is annual-compound (converted to continuous
#' ω = ln(1+UFR) internally); `alpha` is the convergence speed. Returns
#' tenor, zero rate, discount factor and forward for 1 ... `max_tenor`.
#' @param tenors Observed tenors.
#' @param rates Observed rates (percent values are divided by 100).
#' @param ufr Ultimate forward rate, annual-compound.
#' @param alpha Convergence speed (EIOPA floor 0.05).
#' @param max_tenor Last tenor of the output.
#' @param zero_input `TRUE` for zero rates, `FALSE` for par (annual coupon) rates.
#' @param compounding Reserved; rates are annual-compound.
#' @return A `scelo_table` with attributes `zeta` (the Smith-Wilson weights).
#' @examples
#' sc_smith_wilson(c(1, 2, 5, 10, 30), c(0.032, 0.0325, 0.034, 0.035, 0.0344))
#' @export
sc_smith_wilson <- function(tenors, rates, ufr = 0.042, alpha = 0.1, max_tenor = 60, zero_input = TRUE, compounding = "annual") {
  .sc_tool("sc_smith_wilson", list(tenors = tenors, rates = rates, ufr = ufr, alpha = alpha, max_tenor = max_tenor, zero_input = zero_input), NULL, {
    u <- as.numeric(tenors)
    r <- as.numeric(rates)
    if (length(u) != length(r)) stop(sprintf("tenors (%d) and rates (%d) must have the same length", length(u), length(r)), call. = FALSE)
    if (max(r) > 1) r <- r / 100
    omega <- log(1 + ufr)
    if (zero_input) {
      p_obs <- (1 + r)^-u
      C <- diag(length(u))
      cf_times <- u
    } else {  # par (coupon) bonds paying annually
      n <- as.integer(round(max(u)))
      cf_times <- as.numeric(seq_len(n))
      C <- matrix(0, length(u), n)
      for (k in seq_along(u)) {
        m <- as.integer(round(u[k]))
        C[k, seq_len(m)] <- r[k]
        C[k, m] <- C[k, m] + 1
      }
      p_obs <- rep(1, length(u))
    }
    mu <- exp(-omega * cf_times)
    W <- .sc_wilson(cf_times, cf_times, alpha, omega)
    A <- C %*% W %*% t(C)
    zeta <- solve(A, p_obs - as.vector(C %*% mu))
    t <- as.numeric(seq_len(max_tenor))
    p <- exp(-omega * t) + as.vector(.sc_wilson(t, cf_times, alpha, omega) %*% (t(C) %*% zeta))
    z <- p^(-1 / t) - 1
    prev <- c(1, p[-length(p)])
    fwd <- prev / p - 1
    out <- data.frame(tenor = as.integer(t), `zero rate` = z, `discount factor` = p, `1y forward` = fwd, check.names = FALSE)
    tbl <- sc_table(out, title = sprintf("Smith–Wilson · UFR %.2f%% · α %s · to %dy", 100 * ufr, .sc_gnum(alpha), as.integer(max_tenor)),
                    basis = sprintf("%d %s rates · UFR %.2f%% · α %s", length(u), if (zero_input) "zero" else "par", 100 * ufr, .sc_gnum(alpha)), stage = "hard",
                    notes = c("P(t) = e^{−ωt} + Σ ζ_j W(t, u_j) with the Wilson kernel W(t,u) = e^{−ω(t+u)}(α·min(t,u) − ½e^{−α·max(t,u)}(e^{α·min} − e^{−α·min})); fits the observed prices exactly and converges to the UFR forward.",
                              sprintf("Last observed tenor %sy; convergence speed α = %s (EIOPA floor 0.05).", .sc_gnum(max(u)), .sc_gnum(alpha))))
    attr(tbl, "zeta") <- as.vector(zeta)
    tbl
  })
}

# ── Nelson–Siegel / Svensson ─────────────────────────────────────────────

.sc_ns_design <- function(t, lam) {
  x <- t * lam
  f1 <- (1 - exp(-x)) / x
  cbind(1, f1, f1 - exp(-x))
}

.sc_nss_design <- function(t, l1, l2) {
  x1 <- t * l1
  x2 <- t * l2
  f1 <- (1 - exp(-x1)) / x1
  cbind(1, f1, f1 - exp(-x1), (1 - exp(-x2)) / x2 - exp(-x2))
}

.sc_curve_inputs <- function(tenors, rates) {
  t <- as.numeric(tenors)
  r <- as.numeric(rates)
  if (length(t) != length(r)) stop(sprintf("tenors (%d) and rates (%d) must have the same length", length(t), length(r)), call. = FALSE)
  if (max(r) > 1) r <- r / 100
  list(t = t, r = r)
}

#' Nelson–Siegel fit
#'
#' z(t) = β₀ + β₁(1−e^(−λt))/(λt) + β₂((1−e^(−λt))/(λt) − e^(−λt)); λ by
#' grid search (60 values in 0.05 ... 2) unless given, β by least squares.
#' @param tenors Quoted tenors.
#' @param rates Quoted zero rates (percent values are divided by 100).
#' @param lam Decay λ; `NULL` to search.
#' @param max_tenor Last tenor of the output.
#' @return A `scelo_table` (tenor, zero rate, discount factor) with
#'   attributes `beta` and `lam`.
#' @examples
#' sc_nelson_siegel(c(1, 2, 3, 5, 7, 10, 20, 30), c(2, 2.3, 2.5, 2.8, 3, 3.2, 3.5, 3.6))
#' @export
sc_nelson_siegel <- function(tenors, rates, lam = NULL, max_tenor = 60) {
  .sc_tool("sc_nelson_siegel", Filter(Negate(is.null), list(tenors = tenors, rates = rates, lam = lam, max_tenor = max_tenor)), NULL, {
    inp <- .sc_curve_inputs(tenors, rates)
    t <- inp$t
    r <- inp$r
    grid <- if (!is.null(lam) && lam != 0) lam else seq(0.05, 2.0, length.out = 60)
    best <- NULL
    for (L in grid) {
      X <- .sc_ns_design(t, L)
      beta <- .sc_lstsq(X, r)
      sse <- sum((as.vector(X %*% beta) - r)^2)
      if (is.null(best) || sse < best$sse) best <- list(sse = sse, L = L, beta = beta)
    }
    tt <- as.numeric(seq_len(max_tenor))
    z <- as.vector(.sc_ns_design(tt, best$L) %*% best$beta)
    out <- data.frame(tenor = as.integer(tt), `zero rate` = z, `discount factor` = (1 + z)^-tt, check.names = FALSE)
    b <- best$beta
    tbl <- sc_table(out, title = sprintf("Nelson–Siegel · λ %.3f", best$L), basis = sprintf("β = (%.4f, %.4f, %.4f) · λ %.3f", b[1], b[2], b[3], best$L), stage = "hard",
                    notes = sprintf("Level β₀ %.4f%%, slope β₁ %.4f%%, curvature β₂ %.4f%%; RMSE %.2e over %d quotes.", 100 * b[1], 100 * b[2], 100 * b[3], sqrt(best$sse / length(t)), length(t)))
    attr(tbl, "beta") <- b
    attr(tbl, "lam") <- best$L
    tbl
  })
}

#' Nelson–Siegel–Svensson fit
#'
#' Four β and two λ, by a coarse grid on (λ₁, λ₂) (25 × 25 values) with
#' linear β.
#' @inheritParams sc_nelson_siegel
#' @param lam1,lam2 Decays; `NULL` to search.
#' @return A `scelo_table` (tenor, zero rate, discount factor) with
#'   attributes `beta` and `lam` (= `c(lam1, lam2)`).
#' @examples
#' sc_nss(c(1, 2, 3, 5, 7, 10, 20, 30), c(2, 2.3, 2.5, 2.8, 3, 3.2, 3.5, 3.6))
#' @export
sc_nss <- function(tenors, rates, lam1 = NULL, lam2 = NULL, max_tenor = 60) {
  .sc_tool("sc_nss", Filter(Negate(is.null), list(tenors = tenors, rates = rates, lam1 = lam1, lam2 = lam2, max_tenor = max_tenor)), NULL, {
    inp <- .sc_curve_inputs(tenors, rates)
    t <- inp$t
    r <- inp$r
    g1 <- if (!is.null(lam1) && lam1 != 0) lam1 else seq(0.05, 1.5, length.out = 25)
    g2 <- if (!is.null(lam2) && lam2 != 0) lam2 else seq(0.05, 3.0, length.out = 25)
    best <- NULL
    for (L1 in g1) {
      for (L2 in g2) {
        if (abs(L1 - L2) < 1e-6) next
        X <- .sc_nss_design(t, L1, L2)
        beta <- .sc_lstsq(X, r)
        sse <- sum((as.vector(X %*% beta) - r)^2)
        if (is.null(best) || sse < best$sse) best <- list(sse = sse, L1 = L1, L2 = L2, beta = beta)
      }
    }
    if (is.null(best)) stop("lam1 and lam2 must differ", call. = FALSE)
    tt <- as.numeric(seq_len(max_tenor))
    z <- as.vector(.sc_nss_design(tt, best$L1, best$L2) %*% best$beta)
    out <- data.frame(tenor = as.integer(tt), `zero rate` = z, `discount factor` = (1 + z)^-tt, check.names = FALSE)
    tbl <- sc_table(out, title = sprintf("Nelson–Siegel–Svensson · λ₁ %.3f · λ₂ %.3f", best$L1, best$L2), basis = sprintf("β = (%s)", paste(sprintf("%.4f", best$beta), collapse = ", ")),
                    stage = "hard", notes = sprintf("RMSE %.2e over %d quotes.", sqrt(best$sse / length(t)), length(t)))
    attr(tbl, "beta") <- best$beta
    attr(tbl, "lam") <- c(best$L1, best$L2)
    tbl
  })
}

# ── Hull–White short rate ─────────────────────────────────────────────────

#' Hull–White short-rate paths
#'
#' One-factor Hull–White / Vasicek: dr = (θ(t) − a·r)dt + σ dW, Euler on a
#' monthly grid. `theta` defaults to a·r0 (mean-reverting to r0); a vector
#' gives θ per year (the last value is held for any remaining years).
#' Returns per-step mean / p5 / p95 short rate and the mean discount factor
#' (the Monte-Carlo zero curve); the simulated paths (steps × paths) are in
#' `attr(, "paths")`. Uses R's RNG: `seed` makes a run reproducible (the
#' session's RNG state is restored afterwards).
#' @param r0 Initial short rate.
#' @param a Mean-reversion speed.
#' @param sigma Volatility.
#' @param theta Drift θ: `NULL` (a·r0), a number, or one value per year.
#' @param horizon Years.
#' @param steps_per_year Steps per year.
#' @param n_paths Number of paths.
#' @param seed Seed for R's RNG, or `NULL`.
#' @return A `scelo_table` (t, mean, p5, p95, mean df) with attribute `paths`.
#' @examples
#' sc_hull_white(0.04, n_paths = 200, horizon = 3, seed = 1)
#' @export
sc_hull_white <- function(r0 = 0.04, a = 0.1, sigma = 0.01, theta = NULL, horizon = 30, steps_per_year = 12, n_paths = 1000, seed = 42) {
  .sc_tool("sc_hull_white", Filter(Negate(is.null), list(r0 = r0, a = a, sigma = sigma, theta = theta, horizon = horizon, steps_per_year = steps_per_year, n_paths = n_paths, seed = seed)), NULL, {
    n <- as.integer(horizon * steps_per_year)
    dt <- 1 / steps_per_year
    th <- if (is.null(theta)) rep(a * r0, n) else if (length(theta) == 1) rep(as.numeric(theta), n) else rep_len(rep(as.numeric(theta), each = steps_per_year), n)
    rates <- .sc_with_seed(seed, {
      paths <- matrix(0, n, n_paths)
      r <- rep(r0, n_paths)
      for (k in seq_len(n)) {
        r <- r + (th[k] - a * r) * dt + sigma * sqrt(dt) * stats::rnorm(n_paths)
        paths[k, ] <- r
      }
      paths
    })
    integ <- matrix(apply(rates, 2, cumsum), n, n_paths) * dt
    dfs <- exp(-integ)
    out <- data.frame(t = seq_len(n) / steps_per_year, mean = rowMeans(rates),
                      p5 = apply(rates, 1, stats::quantile, probs = 0.05, names = FALSE, type = 7),
                      p95 = apply(rates, 1, stats::quantile, probs = 0.95, names = FALSE, type = 7),
                      `mean df` = rowMeans(dfs), check.names = FALSE)
    tbl <- sc_table(out, title = sprintf("Hull–White short rate · %s paths · %sy", formatC(n_paths, format = "d", big.mark = ","), format(horizon)),
                    basis = sprintf("r0 %.2f%% · a %s · σ %s", 100 * r0, .sc_gnum(a), .sc_gnum(sigma)), stage = "hard",
                    notes = "Euler discretisation of dr = (θ − a·r)dt + σ dW; mean df = E[exp(−∫r)] is the model's zero-coupon price (Monte Carlo).")
    attr(tbl, "paths") <- rates
    tbl
  })
}
