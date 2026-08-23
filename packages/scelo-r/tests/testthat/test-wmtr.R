# The WMTR engine against the TypeScript fixture (wmtr_fixture.json) and the
# cases of scelo-py's tests/test_wmtr_swarm.py.

wmtr_fixture <- local({
  cache <- NULL
  function() {
    if (is.null(cache)) {
      skip_if_not_installed("jsonlite")
      cache <<- jsonlite::fromJSON(fixture_path("wmtr_fixture.json"), simplifyVector = TRUE)
    }
    cache
  }
})

params_from_config <- function(cfg) do.call(sc_wmtr_params, cfg) # cfg carries a `thresholds` sub-list

test_that("mulberry32 is bit-exact with the engine", {
  fx <- wmtr_fixture()
  r <- sc_mulberry32(42)
  draws <- vapply(1:8, function(i) r(), numeric(1))
  expect_identical(draws, as.numeric(fx$rng42))
  r2 <- sc_mulberry32(42)
  expect_identical(r2(8), draws)
  expect_identical(r2(0), numeric())
  # the same seed modulo 2^32, as JavaScript's `>>> 0`
  expect_identical(sc_mulberry32(42 + 2^32)(3), sc_mulberry32(42)(3))
  # blocks of 2^20 join seamlessly, and a long stream is still exact
  a <- sc_mulberry32(1)(1048576L + 10L)
  r3 <- sc_mulberry32(1)
  b <- c(r3(1048576L), r3(10L))
  expect_identical(a, b)
  expect_identical(a[1048577:1048586], sc_mulberry32(1)(1048586L)[1048577:1048586])
})

for (case in c("default", "severe", "mild_long", "rural", "pension")) {
  test_that(sprintf("engine matches the TypeScript fixture: %s", case), {
    fx <- wmtr_fixture()[[case]]
    res <- sc_run_wmtr(params_from_config(fx$config))
    expect_s3_class(res, "scelo_wmtr")
    expect_s3_class(res$table, "scelo_table")
    expect_identical(names(res$table), c("year", "mean_W", "p10_W", "p25_W", "p75_W", "p90_W", "survival", "mean_M", "mean_T", "mean_R"))
    expect_equal(nrow(res$table), fx$config$horizon + 1)
    for (kv in list(c("mean_W", "meanW"), c("p10_W", "p10W"), c("p90_W", "p90W"), c("survival", "meanSurv"), c("mean_M", "meanM"), c("mean_T", "meanT"), c("mean_R", "meanR"))) {
      expect_close(res$table[[kv[1]]], fx[[kv[2]]], tol = 1e-9, label = kv[1])
    }
    kinds <- c("grew", "stabilized", "declined", "collapsed")
    expect_identical(unname(unlist(res$outcome_fractions[kinds])), unname(as.numeric(unlist(fx$outcomeFractions[kinds]))))
    expect_identical(res$dominant, fx$dominant)
    for (k in c("M", "T", "R", "net")) expect_close(res$drivers[[k]], fx$drivers[[k]], tol = 1e-9, label = paste("driver", k))
    expect_close(res$w0, fx$w0, tol = 1e-12)
    expect_identical(attr(res$table, "dominant"), fx$dominant)
    expect_equal(res$survival, res$table$survival[nrow(res$table)])
  })
}

test_that("derive_config matches the IDE (cues, presets, FNV-1a seed)", {
  fx <- wmtr_fixture()
  p <- sc_derive_config("rural village facing a severe drought")
  expect_identical(p$shock, "severe")
  expect_equal(p$alphaM, 0.3)
  expect_equal(c(p$wF, p$wRel, p$wS, p$sqftPerResident), c(0.5, 0.3, 0.2, 800))
  expect_equal(p$seed, fx$rural$config$seed) # 3098
  p2 <- sc_derive_config("pension scheme with a weakening sponsor covenant, long-term")
  expect_equal(p2$alphaR, 0.4)
  expect_equal(p2$horizon, 60L)
  expect_equal(p2$seed, fx$pension$config$seed) # 5958
  # word-bounded cues: "software"/"warranty"/"award"/"forward" must not read as "war"
  expect_identical(sc_derive_config("software warranty award forward normalising")$shock, "moderate")
  expect_equal(sc_derive_config("motor_reserving_triangle_2024")$alphaM, 0.55)
  expect_identical(sc_derive_config("a calm, orderly year")$shock, "mild")
  expect_equal(sc_derive_config("downtown life insurance book, next year")$horizon, 10L)
  expect_equal(sc_derive_config("downtown life insurance book, next year")$alphaM, 0.5)
  # overrides ride along
  expect_equal(sc_derive_config("rural village", nPaths = 5, alpha_m = 0.9)$alphaM, 0.9)
  expect_equal(sc_derive_config("rural village", nPaths = 5)$nPaths, 5L)
})

test_that("a derived scenario reproduces the fixture end to end", {
  fx <- wmtr_fixture()$rural
  res <- sc_wmtr("rural village facing a severe drought")
  expect_close(res$table$mean_W, fx$meanW, tol = 1e-9)
  expect_identical(res$dominant, fx$dominant)
  expect_match(sc_title(res$table), "WMTR forecast · severe shocks · 30y · 200 paths · seed 3098")
  expect_match(sc_notes(res$table)[1], "^Outcomes: grew 0% · stabilized 8% · declined 92% · collapsed 0% \\(dominant: declined\\)")
})

test_that("driver identity and classification", {
  res <- sc_wmtr(shock = "moderate", nPaths = 50, seed = 3)
  d <- res$drivers
  expect_lt(abs(d$M + d$T + d$R - d$net), 1e-12)
  for (pth in res$paths) {
    w0 <- pth$w[1]
    wT <- pth$w[length(pth$w)]
    if (pth$outcome == "grew") expect_gt(wT, w0 * 1.2)
    if (pth$outcome == "declined") expect_lt(wT, w0 * 0.9)
  }
  expect_identical(sc_classify(c(1, 1, 0.1, 0.1, 0.1, 0.1, 0.1, 1.5), 1), "collapsed")
  expect_identical(sc_classify(c(1, 1.3), 1), "grew")
  expect_identical(sc_classify(c(1, 0.95), 1), "stabilized")
  expect_identical(sc_classify(c(1, 0.8), 1), "declined")
  expect_identical(sc_classify(c(1, 0.1, 0.1, 0.1, 0.1, 1.5), 1, recovery = 5), "grew")
  expect_identical(sc_dominant_driver(res), c("M", "T", "R")[which.max(abs(c(d$M, d$T, d$R)))])
  expect_equal(sc_driver_contributions(res, up_to = 0), list(M = 0, T = 0, R = 0, net = 0))
})

test_that("wmtr from a scenario row, interventions and sensitivity", {
  res <- sc_wmtr(sc_sample("wmtr-scenarios"), nPaths = 10)
  expect_identical(res$params$shock, "severe")
  expect_equal(res$params$alphaR, 0.4)
  expect_equal(res$params$initFamily, 0.8)
  expect_equal(res$params$nPaths, 10L)
  p <- sc_apply_intervention(res$params, "shock", "decrease")
  expect_identical(p$shock, "moderate")
  expect_identical(sc_apply_intervention(p, "shock", "decrease")$shock, "mild")
  expect_identical(sc_apply_intervention(sc_apply_intervention(p, "shock", "decrease"), "shock", "decrease")$shock, "mild")
  p2 <- sc_apply_intervention(res$params, "pFamily", "increase", "large")
  expect_lt(abs(p2$pFamily - min(1, res$params$pFamily + 0.2)), 1e-12)
  expect_equal(sc_apply_intervention(res$params, "wF", "decrease")$wF, res$params$wF - 0.07)
  expect_error(sc_apply_intervention(res$params, "horizon"), "param must be one of")
  expect_error(sc_apply_intervention(sc_wmtr_params(shock = "huge"), "shock"), "shock must be one of mild, moderate, severe")
  s <- sc_sensitivity(shock = "moderate", nPaths = 20, seed = 1)
  expect_s3_class(s, "scelo_table")
  expect_identical(s$shock, c("mild", "moderate", "severe"))
  expect_identical(names(s), c("shock", "grew", "stabilized", "declined", "collapsed", "survival", "W/W0"))
  expect_match(sc_notes(s)[1], "^Collapse-Δ \\(severe − mild\\) = [+-][0-9.]+%")
  expect_identical(sc_basis(s), "horizon 30y · 20 paths · seed 1")
  # a named list is a row too
  expect_identical(sc_wmtr(list(alpha_m = 0.5, shock = "Mild", horizon = 5), nPaths = 3)$params$shock, "mild")
})

test_that("overrides by engine name or column name; unknown names fail", {
  a <- sc_wmtr(alpha_m = 0.5, n_paths = 5, horizon = 5)
  b <- sc_wmtr(alphaM = 0.5, nPaths = 5, horizon = 5)
  expect_equal(a$params$alphaM, 0.5)
  expect_identical(a$table$mean_W, b$table$mean_W)
  expect_equal(sc_wmtr(NPATHS = 5, horizon = 5, Shock = "SEVERE")$params$shock, "severe")
  expect_error(sc_wmtr(alpha_q = 1), "unknown WMTR parameter 'alpha_q'")
  expect_error(sc_run_wmtr(sc_wmtr_params(shock = "huge")), "shock must be one of")
  # a params object plus overrides
  p <- sc_wmtr_params(horizon = 5, nPaths = 5)
  expect_identical(sc_wmtr(p, seed = 9)$params$seed, 9)
  expect_identical(sc_wmtr(p)$params, p)
  expect_identical(SC_DEFAULT_WMTR_PARAMS, sc_wmtr_params())
  expect_identical(SC_DEFAULT_WMTR_PARAMS$shock, "moderate")
  expect_equal(SC_SHOCK_PARAMS$severe$lam, 0.45)
})

test_that("print methods and the audit trail", {
  sc_clear_audit()
  res <- sc_wmtr(nPaths = 5, horizon = 5)
  expect_output(print(res), "WMTR · moderate · 5y · 5 paths · survival@horizon")
  expect_output(print(res$params), "WMTR parameters · moderate shocks · 5y · 5 paths · seed 42")
  a <- sc_audit()
  expect_identical(a$fn, "sc_wmtr")
  expect_identical(a$out_shape, "6×10")
})

test_that("a 200-path 30-year forecast is quick", {
  t0 <- proc.time()[["elapsed"]]
  sc_run_wmtr(sc_wmtr_params())
  expect_lt(proc.time()[["elapsed"]] - t0, 2)
})
