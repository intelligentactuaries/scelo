# Finance: the Exam-FM toolkit, discount curves, Smith-Wilson, Nelson-Siegel
# and Hull-White against the values the Python package computes.

expect_curve_close <- function(got, want, tol = 1e-9) {
  expect_equal(names(got), names(want))
  for (c in names(want)) expect_close(got[[c]], want[[c]], tol, label = c)
}

test_that("discount-curve table: flat, quoted tenors, percent data frame", {
  g <- golden()
  dc <- sc_discount_curve(0.05, max_tenor = 10)
  expect_s3_class(dc, "scelo_table")
  expect_equal(names(dc), c("tenor", "zero rate", "discount factor", "1y forward", "annuity-certain a_n"))
  expect_lt(abs(dc[["discount factor"]][5] - 1.05^-5), 1e-12)
  expect_lt(abs(dc[["1y forward"]][4] - 0.05), 1e-12)
  expect_lt(abs(dc[["annuity-certain a_n"]][10] - (1 - 1.05^-10) / 0.05), 1e-12)
  expect_curve_close(sc_df(dc), split_df(g$discount_curve_flat5), 1e-10)
  expect_equal(attr(dc, "title"), "Discount curve · flat 5 % · to 10y")
  expect_equal(attr(dc, "basis"), "flat 5 %")
  expect_equal(sc_notes(dc)[1], "Flat 5 % curve: every tenor discounts at the same rate.")
  expect_match(sc_notes(dc)[2], "^Zero rates are annual-compound")
  dc2 <- sc_discount_curve(c(`1` = 0.03, `5` = 0.04, `10` = 0.05), max_tenor = 12)
  expect_lt(abs(dc2[["zero rate"]][3] - 0.035), 1e-12)
  expect_lt(abs(dc2[["zero rate"]][12] - 0.05), 1e-12)
  expect_curve_close(sc_df(dc2), split_df(g$discount_curve_pts), 1e-10)
  expect_equal(attr(dc2, "title"), "Discount curve · 3 quoted tenors · to 12y")
  expect_length(sc_notes(dc2), 1)
  dc3 <- sc_discount_curve(data.frame(tenor = c(1, 2), rate = c(3.0, 4.0)), max_tenor = 2)  # percent values
  expect_lt(abs(dc3[["zero rate"]][1] - 0.03), 1e-12)
  expect_equal(attr(dc3, "basis"), "`rate` by `tenor`")
  expect_equal(nrow(dc3), 2)
  dc4 <- sc_discount_curve(df = data.frame(maturity = c(5, 1, 1), yield = c(0.04, 0.03, 0.02)), max_tenor = 5)  # tenors averaged, sorted
  expect_lt(abs(dc4[["zero rate"]][1] - 0.025), 1e-12)
  expect_lt(abs(dc4[["zero rate"]][3] - 0.0325), 1e-12)
  dc5 <- sc_discount_curve(list(c(1, 3), c(5, 4)), max_tenor = 6)  # pairs, percent
  expect_lt(abs(dc5[["zero rate"]][3] - 0.035), 1e-12)
  expect_lt(abs(dc5[["zero rate"]][6] - 0.04), 1e-12)
  dc6 <- sc_discount_curve()
  expect_equal(nrow(dc6), 30)
  expect_equal(attr(dc6, "basis"), "flat 4 %")
  expect_equal(nrow(sc_discount_curve(c(`1` = 0.03, `40` = 0.05))), 40)
  expect_error(sc_discount_curve(c(0.03, 0.04)), "curve must be")
  expect_error(sc_discount_curve("abc"), "curve must be")
})

test_that("Exam-FM toolkit", {
  fm <- golden()$fm
  expect_lt(abs(sc_annuity_certain(10, 0.05) - (1 - 1.05^-10) / 0.05), 1e-12)
  expect_lt(abs(sc_annuity_certain(10, 0.05, due = TRUE) - (1 - 1.05^-10) / (0.05 / 1.05)), 1e-12)
  expect_lt(abs(sc_accumulation(10, 0.05) - ((1.05^10 - 1) / 0.05)), 1e-9)
  expect_lt(abs(sc_irr(c(-100, 60, 60)) - 0.1306623862918075), 1e-8)
  expect_lt(abs(sc_pv(rep(100, 5), 0.05) - 100 * sc_annuity_certain(5, 0.05)), 1e-9)
  expect_lt(abs(sc_bond_price(100, 0.05, 10, 0.05) - 100), 1e-9)
  expect_lt(abs(sc_bond_yield(100, 100, 0.05, 10) - 0.05), 1e-6)
  d <- sc_duration(c(rep(5, 9), 105), 0.05)
  expect_true(d > 7 && d < 9)
  expect_lt(sc_duration(c(rep(5, 9), 105), 0.05, modified = TRUE), d)
  z <- sc_bootstrap_par(c(0.03, 0.035, 0.04))
  expect_lt(abs(z[[1]] - 0.03), 1e-12)
  expect_gt(z[[3]], 0.04)
  expect_equal(names(z), c("1", "2", "3"))
  expect_error(sc_irr(c(100, 10)), "IRR not bracketed: NPV has the same sign at both ends")
  # golden values computed by the Python package
  expect_close(sc_annuity_certain(10, 0.05), fm$annuity_10_5, 1e-12, "a_10")
  expect_close(sc_annuity_certain(10, 0.05, due = TRUE), fm$annuity_due, 1e-12, "a_due")
  expect_close(sc_annuity_certain(10, 0.05, increasing = TRUE), fm$Ia, 1e-12, "Ia")
  expect_close(sc_irr(c(-100, 60, 60)), fm$irr, 1e-10, "irr")
  expect_close(sc_duration(c(rep(5, 9), 105), 0.05), fm$duration, 1e-12, "duration")
  expect_close(sc_convexity(c(rep(5, 9), 105), 0.05), fm$convexity, 1e-12, "convexity")
  expect_close(sc_bond_yield(95, 100, 0.05, 10), fm$bond_yield, 1e-10, "bond yield")
  expect_close(unname(z), fm$bootstrap_par, 1e-12, "bootstrap par")
  # identities
  expect_equal(sc_annuity_certain(10, 0), 10)
  expect_equal(sc_annuity_certain(10, 0, increasing = TRUE), 55)
  expect_close(sc_annuity_certain(10, 0.05, increasing = TRUE, due = TRUE), fm$Ia * 1.05, 1e-12)
  expect_lt(sc_annuity_certain(10, 0.05, m = 12), sc_annuity_certain(10, 0.05, due = TRUE))
  expect_gt(sc_annuity_certain(10, 0.05, m = 12), sc_annuity_certain(10, 0.05))
  expect_close(sc_accumulation(10, 0.05, due = TRUE), sc_annuity_certain(10, 0.05, due = TRUE) * 1.05^10, 1e-12)
  expect_close(sc_npv(0.1, c(-100, 60, 60)), -100 + 60 / 1.1 + 60 / 1.21, 1e-12)
  expect_close(sc_npv(0.1, c(60, 60), t0 = FALSE), 60 / 1.1 + 60 / 1.21, 1e-12)
  expect_close(sc_v(0.05, 1:3), 1.05^-(1:3), 1e-15)
  expect_close(sc_pv(c(100, 100), c(`1` = 0.03, `2` = 0.04)), 100 / 1.03 + 100 / 1.04^2, 1e-12)
  expect_close(sc_pv(c(100, 100), 0.05, times = c(0.5, 1.5)), 100 * 1.05^-0.5 + 100 * 1.05^-1.5, 1e-12)
  expect_close(sc_bond_price(100, 0.06, 5, 0.05, m = 2), sc_pv(c(rep(3, 9), 103), 0.025, times = 1:10), 1e-9)
  expect_close(sc_bond_price(100, 0.05, 3, 0), 115, 1e-12)
  expect_close(sc_bond_yield(sc_bond_price(100, 0.04, 7, 0.06, m = 2, redemption = 105), 100, 0.04, 7, m = 2, redemption = 105), 0.06, 1e-8)
  # rate conversions of scelo.finance (defined in R/extras.R)
  expect_close(sc_effective(sc_nominal(0.05, 12), 12), 0.05, 1e-12)
  expect_close(sc_from_force(sc_force(0.05)), 0.05, 1e-12)
  expect_close(sc_discount_rate(0.05), 0.05 / 1.05, 1e-12)
  expect_close(sc_nominal(0.05, 1), 0.05, 1e-12)
})

test_that("zero rates, discount factors and forwards", {
  expect_close(sc_zero_to_df(0.05, 1:3), 1.05^-(1:3), 1e-15)
  expect_close(sc_df_to_zero(sc_zero_to_df(c(0.03, 0.04), c(2, 5)), c(2, 5)), c(0.03, 0.04), 1e-12)
  f <- sc_forward_rates(c(0.03, 0.035, 0.04))
  expect_equal(names(f), c("1", "2", "3"))
  expect_close(f[[1]], 0.03, 1e-12)
  expect_close(f[[2]], 1.035^2 / 1.03 - 1, 1e-12)
  f2 <- sc_forward_rates(c(0.03, 0.04), tenors = c(1, 3))
  expect_close(f2[[2]], (1.04^3 / 1.03)^(1 / 2) - 1, 1e-12)
  z <- sc_bootstrap_par(c(0.03, 0.035, 0.04), tenors = 1:3)
  expect_close(sum(sc_zero_to_df(z, 1:3)) * 0.04 + sc_zero_to_df(z[[3]], 3), 1, 1e-12)  # the 3y par bond prices at par
})

test_that("Smith-Wilson fits exactly and converges to the UFR", {
  g <- golden()
  t <- c(1, 2, 5, 10, 30)
  r <- c(0.032, 0.0325, 0.034, 0.035, 0.0344)
  sw <- sc_smith_wilson(t, r, ufr = 0.042, alpha = 0.1, max_tenor = 120)
  expect_s3_class(sw, "scelo_table")
  expect_equal(names(sw), c("tenor", "zero rate", "discount factor", "1y forward"))
  for (k in seq_along(t)) expect_lt(abs(sw[["zero rate"]][sw$tenor == t[k]] - r[k]), 1e-9)
  expect_lt(abs(sw[["1y forward"]][120] - 0.042), 2e-3)
  sw60 <- sc_smith_wilson(t, r)
  expect_equal(nrow(sw60), 60)
  expect_curve_close(sc_df(sw60), split_df(g$smith_wilson), 1e-9)
  expect_equal(attr(sw60, "title"), "Smith–Wilson · UFR 4.20% · α 0.1 · to 60y")
  expect_equal(attr(sw60, "basis"), "5 zero rates · UFR 4.20% · α 0.1")
  expect_equal(sc_notes(sw60)[2], "Last observed tenor 30y; convergence speed α = 0.1 (EIOPA floor 0.05).")
  expect_match(sc_notes(sw60)[1], "^P\\(t\\) = e\\^\\{−ωt\\}")
  swp <- sc_smith_wilson(t, 100 * r, zero_input = FALSE, max_tenor = 40)  # percent par rates
  expect_equal(attr(swp, "basis"), "5 par rates · UFR 4.20% · α 0.1")
  p <- swp[["discount factor"]]
  for (k in seq_along(t)) expect_lt(abs(r[k] * sum(p[seq_len(t[k])]) + p[t[k]] - 1), 1e-9)  # each par bond prices at par
  expect_error(sc_smith_wilson(1:3, 1:2), "same length")
})

test_that("Nelson-Siegel and Svensson fit the quotes", {
  g <- golden()$nelson_siegel
  t <- g$tenors
  r <- g$rates
  ns <- sc_nelson_siegel(t, r)
  expect_lt(max(abs(ns[["zero rate"]][t] - r)), 1e-3)
  expect_equal(nrow(ns), 60)
  expect_equal(names(ns), c("tenor", "zero rate", "discount factor"))
  expect_true(attr(ns, "lam") >= 0.05 && attr(ns, "lam") <= 2)
  expect_length(attr(ns, "beta"), 3)
  ns5 <- sc_nelson_siegel(t, r, lam = 0.5, max_tenor = 30)
  expect_curve_close(sc_df(ns5), split_df(g$curve), 1e-9)
  expect_equal(attr(ns5, "lam"), 0.5)
  expect_equal(attr(ns5, "title"), "Nelson–Siegel · λ 0.500")
  b <- attr(ns5, "beta")
  expect_equal(attr(ns5, "basis"), sprintf("β = (%.4f, %.4f, %.4f) · λ 0.500", b[1], b[2], b[3]))
  expect_match(sc_notes(ns5), "^Level β₀ [-0-9.]+%, slope β₁ [-0-9.]+%, curvature β₂ [-0-9.]+%; RMSE [0-9.]+e-[0-9]+ over 8 quotes\\.$")
  ns_pct <- sc_nelson_siegel(t, 100 * r, lam = 0.5, max_tenor = 30)  # percent quotes
  expect_curve_close(sc_df(ns_pct), split_df(g$curve), 1e-9)
  nss <- sc_nss(t, r)
  expect_lt(max(abs(nss[["zero rate"]][t] - r)), 1e-3)
  expect_length(attr(nss, "beta"), 4)
  expect_length(attr(nss, "lam"), 2)
  expect_match(attr(nss, "title"), "^Nelson–Siegel–Svensson · λ₁ [0-9.]+ · λ₂ [0-9.]+$")
  expect_match(attr(nss, "basis"), "^β = \\([-0-9.]+, [-0-9.]+, [-0-9.]+, [-0-9.]+\\)$")
  expect_match(sc_notes(nss), "^RMSE [0-9.]+e-[0-9]+ over 8 quotes\\.$")
  nss2 <- sc_nss(t, r, lam1 = 0.3, lam2 = 1.2)
  expect_equal(attr(nss2, "lam"), c(0.3, 1.2))
  expect_error(sc_nss(t, r, lam1 = 0.5, lam2 = 0.5), "must differ")
})

test_that("Hull-White paths", {
  hw <- sc_hull_white(0.04, n_paths = 500, horizon = 3, seed = 1)
  expect_s3_class(hw, "scelo_table")
  expect_equal(nrow(hw), 36)
  expect_equal(names(hw), c("t", "mean", "p5", "p95", "mean df"))
  expect_equal(dim(attr(hw, "paths")), c(36, 500))
  expect_true(all(diff(hw[["mean df"]]) < 0))
  expect_true(all(hw$p5 <= hw$mean & hw$mean <= hw$p95))
  expect_lt(abs(hw$mean[36] - 0.04), 0.01)  # mean-reverting to r0
  expect_equal(hw$t[12], 1)
  expect_equal(attr(hw, "title"), "Hull–White short rate · 500 paths · 3y")
  expect_equal(attr(hw, "basis"), "r0 4.00% · a 0.1 · σ 0.01")
  hw2 <- sc_hull_white(0.04, n_paths = 500, horizon = 3, seed = 1)
  expect_equal(attr(hw2, "paths"), attr(hw, "paths"))  # seeded
  hw3 <- sc_hull_white(0.02, a = 0.5, theta = 0.5 * 0.06, horizon = 10, n_paths = 200, seed = 2)
  expect_gt(hw3$mean[120], 0.05)  # drifts towards θ/a = 6 %
  hw4 <- sc_hull_white(0.03, theta = c(0.003, 0.004), horizon = 3, n_paths = 50, seed = 3)  # θ per year, last held
  expect_equal(nrow(hw4), 36)
  set.seed(99)
  before <- runif(1)
  set.seed(99)
  sc_hull_white(n_paths = 10, horizon = 1, seed = 5)
  expect_equal(runif(1), before)  # the session RNG is restored
})

test_that("finance tools land in the audit trail", {
  sc_clear_audit()
  sc_discount_curve(0.05, max_tenor = 5)
  sc_smith_wilson(c(1, 5), c(0.03, 0.04), max_tenor = 10)
  a <- sc_audit()
  expect_equal(a$fn, c("sc_discount_curve", "sc_smith_wilson"))
  expect_equal(a$out_shape, c("5×5", "10×4"))
})
