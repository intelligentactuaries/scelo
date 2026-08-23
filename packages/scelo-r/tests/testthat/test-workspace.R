# Workspace diagnostics against the Python golden values (py_golden.json) on
# the workspace-demo sample, plus the behavioural checks of test_hard_misc.py.

ws_drivers <- function(ws) setdiff(names(ws), c("annuity_60", "life_exp_60", "survival_to_80"))

test_that("participation ratio", {
  expect_equal(sc_participation_ratio(c(1, 1, 1)), 3)
  expect_equal(sc_participation_ratio(c(3, 1, 0.1)), (4.1)^2 / (9 + 1 + 0.01))
  expect_equal(sc_participation_ratio(c(2, -1, 0, NA)), 1)
  expect_equal(sc_participation_ratio(numeric()), 0)
  expect_equal(sc_participation_ratio(c(0, -2)), 0)
})

test_that("bottleneck matches the Python golden", {
  g <- golden()$bottleneck
  ws <- sc_sample("workspace-demo")
  b <- sc_bottleneck(ws[ws_drivers(ws)], r = 3)
  expect_s3_class(b, "scelo_table")
  expect_identical(b$head, g$heads)
  expect_identical(names(b)[1], "head")
  expect_length(names(b), 4)
  expect_match(names(b)[2], "^code 1: ")
  B <- as.matrix(sc_df(b)[, -1])
  expect_close(B, g$B, tol = 1e-6, label = "B")
  for (m in names(g$metrics)) expect_close(attr(b, m), g$metrics[[m]], tol = 1e-8, label = m)
  expect_true(all(B >= 0))
  expect_gt(attr(b, "causal_alignment"), 0.3)
  expect_identical(sc_basis(b), "PR 3.00 · reconstruction R² 0.14 · causal alignment 0.81 · sparsity 0.43")
  expect_identical(sc_title(b), "Workspace bottleneck · 3 codes · 2,000 rows")
  expect_length(attr(b, "eigenvalues"), 14)
  expect_identical(dim(attr(b, "code_loadings")), c(14L, 4L))
  expect_identical(attr(b, "code_loadings")$head, g$heads)
  # codes are oriented with the row sum
  Z <- scale(as.matrix(ws[ws_drivers(ws)]))
  codes <- Z %*% as.matrix(attr(b, "code_loadings")[, -1])
  for (k in 1:3) expect_gte(stats::cor(codes[, k], rowSums(Z)), 0)
})

test_that("bottleneck arguments: columns, r capped, thinning, errors", {
  ws <- sc_sample("workspace-demo")
  cols <- c("mortality_trend", "cohort_effect", "smoking_index", "crude_rate")
  b <- sc_bottleneck(ws, columns = cols, r = 10)
  expect_identical(b$head, cols)
  expect_length(names(b), 4) # r capped at p - 1 = 3
  b2 <- sc_bottleneck(ws[cols], r = 2, max_rows = 500)
  expect_match(sc_title(b2), "2 codes · 500 rows")
  expect_error(sc_bottleneck(ws[1:5, cols]), "need at least 10 complete rows and 3 numeric columns")
  expect_error(sc_bottleneck(ws[, 1:2]), "need at least 10 complete rows and 3 numeric columns")
  # a column that cannot be numeric drops its rows; text numbers are read
  ws2 <- ws[1:50, cols]
  ws2$smoking_index <- as.character(ws2$smoking_index)
  ws2$smoking_index[1:3] <- "n/a"
  expect_match(sc_title(sc_bottleneck(ws2, r = 2)), "2 codes · 50 rows") # inferred columns are the numeric ones
  expect_match(sc_title(sc_bottleneck(ws2, columns = cols, r = 2)), "2 codes · 47 rows")
})

test_that("active subspace matches the Python golden (names up to eigenvector sign)", {
  g <- golden()$active_subspace
  ws <- sc_sample("workspace-demo")
  a <- sc_active_subspace(ws, "annuity_60", drivers = ws_drivers(ws))
  expect_s3_class(a, "scelo_table")
  expect_identical(names(a), c("direction", "eigenvalue", "sensitivity_share", "variance_share", "name", "loadings"))
  expect_identical(a$direction, 1:6)
  expect_identical(attr(a, "rank"), as.integer(g$rank))
  expect_close(attr(a, "participation_ratio"), g$pr, tol = 1e-8)
  expect_close(attr(a, "surrogate_r2"), g$r2, tol = 1e-8)
  expect_close(a$sensitivity_share, g$sens, tol = 1e-8, label = "sensitivity share")
  expect_close(a$variance_share, g$var, tol = 1e-8, label = "variance share")
  # the sign of an eigenvector is arbitrary (LAPACK dsyevr here, dsyevd in numpy): compare the named loadings without their direction
  strip <- function(s) gsub(" (up|down)\\b", "", s)
  expect_identical(strip(a$name), strip(g$names))
  expect_match(a$loadings[1], "mortality_trend:[+-]0\\.[0-9]{2}")
  expect_identical(sc_title(a), "Active subspace · annuity_60")
  expect_identical(sc_basis(a), "14 drivers · surrogate R² 1.00 · rank 2 · PR 1.09")
  expect_match(sc_notes(a)[2], "^Workspace variance fraction 0\\.143 over the 2 active directions\\.$")
  expect_length(attr(a, "sensitivity_spectrum"), 14)
  expect_length(attr(a, "variance_spectrum"), 14)
  expect_identical(dim(attr(a, "directions")), c(14L, 14L))
  # the eigenvectors are orthonormal
  V <- attr(a, "directions")
  expect_close(crossprod(V), diag(14), tol = 1e-10)
})

test_that("the workspace recovers the real drivers (the Python behavioural test)", {
  ws <- sc_sample("workspace-demo")
  a <- sc_active_subspace(ws, "annuity_60", drivers = ws_drivers(ws))
  expect_gt(attr(a, "surrogate_r2"), 0.9)
  expect_true(attr(a, "rank") >= 2 && attr(a, "rank") <= 5)
  expect_true(grepl("mortality trend", a$name[1]) || grepl("cohort effect", a$name[1]))
  expect_lt(a$variance_share[1], 0.15) # decision-relevant is not max-variance
  b <- sc_bottleneck(ws[ws_drivers(ws)], r = 3)
  expect_true(all(as.matrix(sc_df(b)[, -1]) >= 0))
  expect_gt(attr(b, "causal_alignment"), 0.3)
  # drivers default to every other numeric column
  a2 <- sc_active_subspace(ws[c(ws_drivers(ws), "annuity_60")], "annuity_60")
  expect_identical(a2$sensitivity_share, a$sensitivity_share)
  expect_error(sc_active_subspace(ws, "nope"), 'column "nope" is not in the data')
})

test_that("workspace tools are audited and quick", {
  ws <- sc_sample("workspace-demo")
  sc_clear_audit()
  t0 <- proc.time()[["elapsed"]]
  sc_bottleneck(ws[ws_drivers(ws)])
  sc_active_subspace(ws, "annuity_60", drivers = ws_drivers(ws))
  expect_lt(proc.time()[["elapsed"]] - t0, 3)
  expect_identical(sc_audit()$fn, c("sc_bottleneck", "sc_active_subspace"))
})
