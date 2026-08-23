# lifelib: the helpers work without Python (tests/test_hard_misc.py
# test_lifelib_helpers_without_lifelib); the model run needs reticulate and
# a Python with lifelib, so it runs only when SCELO_LIFELIB_PYTHON (or
# RETICULATE_PYTHON) points at one.

test_that("the pinned versions and the library table", {
  expect_equal(SC_LIFELIB_VERSION, "0.14.0")
  expect_equal(SC_MODELX_VERSION, "0.32.0")
  m <- sc_lifelib_models()
  expect_equal(nrow(m), 16)
  expect_equal(names(m), c("library", "status", "models", "note"))
  expect_equal(m$library[1], "basiclife")
  expect_true(grepl("BasicTerm_ME", m$models[1], fixed = TRUE))
  expect_equal(sort(unique(m$status)), c("active", "draft", "legacy"))
  expect_equal(sum(m$status == "legacy"), 5)
  expect_equal(m$status[m$library == "uslib"], "draft")
})

test_that("provenance strings", {
  expect_equal(sc_lifelib_provenance("basiclife", "BasicTerm_ME"), "lifelib 0.14.0 · basiclife / BasicTerm_ME")
  expect_true(endsWith(sc_lifelib_provenance("ifrs17sim", "model"), "(legacy)"))
  expect_equal(sc_lifelib_provenance("unknown", "X"), "lifelib 0.14.0 · unknown / X")
})

test_that("lifelib home honours SCELO_LIFELIB_HOME and ends with the version", {
  withr_like <- Sys.getenv("SCELO_LIFELIB_HOME", unset = NA)
  on.exit(if (is.na(withr_like)) Sys.unsetenv("SCELO_LIFELIB_HOME") else Sys.setenv(SCELO_LIFELIB_HOME = withr_like), add = TRUE)
  Sys.setenv(SCELO_LIFELIB_HOME = "/tmp/scelo-lifelib-test")
  expect_equal(sc_lifelib_home(), file.path("/tmp/scelo-lifelib-test", "0.14.0"))
  Sys.unsetenv("SCELO_LIFELIB_HOME")
  h <- sc_lifelib_home()
  expect_equal(basename(h), "0.14.0")
  expect_true(grepl(file.path("scelo", "lifelib", "0.14.0"), h, fixed = TRUE))
})

test_that("normalise_model_points maps the sample onto lifelib's columns", {
  mp <- sc_normalise_model_points(sc_sample("lifelib-mp"))
  expect_equal(nrow(mp), 100)
  expect_equal(names(mp)[1], "policy_id")
  expect_true(all(c("age_at_entry", "sex", "sum_assured", "policy_term", "duration_mth", "premium_pp", "policy_count") %in% names(mp)))
  expect_true(all(mp$sex %in% c("M", "F")))
  expect_equal(mp$policy_id[1:2], c("MP10000", "MP10001"))
  expect_equal(mp$age_at_entry[1:3], c(37L, 43L, 36L))
  expect_equal(mp$duration_mth[1:2], c(97L, 0L))
  expect_true(is.integer(mp$policy_term))
  expect_equal(mp$policy_count, rep(1, 100))
  expect_error(sc_normalise_model_points(data.frame(age = 1)), "a model-point file needs age_at_entry, sum_assured and policy_term columns")
})

test_that("normalise_model_points: aliases, sex codes, numeric strings, duplicate ids, dropped rows", {
  df <- data.frame(id = c("a", "a", "b"), Age = c(30, 40, 0), SA = c("1000", "2000", "3000"), Term = c(10, 20, 30), gender = c("w", NA, "2"), stringsAsFactors = FALSE)
  mp <- sc_normalise_model_points(df)
  expect_equal(nrow(mp), 2)  # age 0 dropped
  expect_equal(mp$policy_id, c("a", "a#1"))
  expect_equal(mp$sex, c("F", "M"))
  expect_equal(mp$sum_assured, c(1000, 2000))
  expect_equal(mp$age_at_entry, c(30L, 40L))
  expect_equal(mp$duration_mth, c(0L, 0L))
  expect_equal(mp$policy_count, c(1, 1))
  expect_equal(names(mp), c("policy_id", "age_at_entry", "sex", "sum_assured", "policy_term", "duration_mth", "policy_count"))
  gen <- sc_normalise_model_points(data.frame(age_at_entry = c(30, NA), sum_assured = c(1, 1), policy_term = c(5, 5)))
  expect_equal(gen$policy_id, "MP00001")
  expect_equal(gen$sex, "M")
})

test_that("sc_lifelib_run explains what it needs when Python is not available", {
  skip_if(requireNamespace("reticulate", quietly = TRUE), "reticulate is installed; the no-Python message is not reachable")
  expect_error(sc_lifelib_run(), "reticulate")
  expect_error(sc_lifelib_run(), "scelo\\[life\\]")
})

test_that("sc_lifelib_run drives BasicTerm_ME through reticulate", {
  py <- Sys.getenv("SCELO_LIFELIB_PYTHON", unset = Sys.getenv("RETICULATE_PYTHON", unset = ""))
  skip_if_not(nzchar(py), "set SCELO_LIFELIB_PYTHON to a Python with lifelib 0.14.0 / modelx 0.32.0 to run lifelib")
  skip_if_not_installed("reticulate")
  reticulate::use_python(py, required = TRUE)
  skip_if_not(reticulate::py_module_available("lifelib") && reticulate::py_module_available("modelx"), "lifelib / modelx not importable")
  cf <- sc_lifelib_run("basiclife", "BasicTerm_ME", sc_sample("lifelib-mp"))
  expect_s3_class(cf, "scelo_table")
  expect_equal(names(cf), c("t", "Premiums", "Claims", "Expenses", "Commissions", "Net Cashflow"))
  expect_equal(nrow(cf), 361)
  expect_equal(cf$t[1:3], c(0, 1, 2))
  expect_close(cf$Premiums[1], 8134.17, 1e-6)
  expect_close(cf[["Net Cashflow"]][1:3], c(-22285.275629, -2822.485322, -2827.713805), 1e-6)
  expect_close(sum(cf[["Net Cashflow"]]), -1373895, 1e-5)
  pv <- attr(cf, "pv")
  expect_equal(nrow(pv), 100)
  expect_equal(pv[[1]][1:2], c("MP10000", "MP10001"))
  expect_close(pv[["PV Net Cashflow"]][1], -4308.638329, 1e-6)
  expect_close(sum(pv[["PV Net Cashflow"]]), -1107596, 1e-5)
  expect_equal(attr(cf, "basis"), "lifelib 0.14.0 · basiclife / BasicTerm_ME")
  expect_equal(attr(cf, "title"), "basiclife / BasicTerm_ME · 100 model points")
  expect_equal(sc_notes(cf)[1], "lifelib 0.14.0 · modelx 0.32.0 · premiums from model-point file.")
  meta <- attr(cf, "meta")
  expect_equal(meta$premium_source, "model-point file")
  expect_equal(meta$model_points, 100)
  expect_true(inherits(attr(cf, "model"), "python.builtin.object"))
})
