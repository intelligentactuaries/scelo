test_that("coerce_cell follows Scelo's import rules", {
  cells <- sc_coerce_cell(c(" 42 ", "007", "NA", "1e3", "0x1f", "", "9007199254740993", "TBD", "-"))
  expect_equal(cells[[1]], 42)
  expect_equal(cells[[2]], "007")
  expect_true(is.na(cells[[3]]))
  expect_equal(cells[[4]], 1000)
  expect_equal(cells[[5]], "0x1f")
  expect_true(is.na(cells[[6]]))
  expect_equal(cells[[7]], "9007199254740993")
  expect_equal(cells[[8]], "TBD")
  expect_true(is.na(cells[[9]]))
})

test_that("samples load with the IDE's shapes", {
  shapes <- list(claims = c(79, 10), climate = c(30, 7), dirty = c(53, 11), `wmtr-scenarios` = c(12, 11), `lifelib-mp` = c(100, 7), `workspace-demo` = c(2000, 17))
  for (k in names(shapes)) expect_equal(dim(sc_sample(k)), shapes[[k]], info = k)
  expect_setequal(sc_samples()$key, names(shapes))
  expect_error(sc_sample("nope"), "unknown sample")
})

test_that("load types columns and de-duplicates headers", {
  df <- sc_sample("claims")
  expect_type(df$origin_year, "integer")
  expect_type(df$paid, "integer")
  expect_type(df$policy_id, "character")
  p <- tempfile(fileext = ".txt")
  writeLines(c("a;b;a", "1;2;3", "4;5;6"), p)
  expect_equal(sc_sniff(p), ";")
  d <- sc_load(p)
  expect_equal(names(d), c("a", "b", "a_2"))
  expect_equal(d$a, c(1L, 4L))
  writeBin(as.raw(rep(c(0, 1, 2), 100)), b <- tempfile(fileext = ".txt"))
  expect_null(sc_sniff(b))
})

test_that("reservoir keeps order and stamps provenance", {
  df <- data.frame(x = 1:1000)
  s <- sc_reservoir(df, 100, seed = 1)
  expect_equal(nrow(s), 100)
  expect_true(!is.unsorted(s$x))
  expect_equal(attr(s, "source_total_rows"), 1000)
})

test_that("describe reproduces the hand-computed golden values", {
  d <- sc_describe(data.frame(x = c(1, 2, 3, 4)))
  expect_equal(d$median, 2.5); expect_equal(d$q1, 1.75); expect_equal(d$q3, 3.25); expect_equal(d$mean, 2.5)
  expect_equal(d$sd, sqrt(5 / 3)); expect_equal(d$se, sqrt(5 / 3) / 2); expect_equal(d$cv, sqrt(5 / 3) / 2.5)
  expect_equal(d$skewness, 0)
  g <- split_df(golden()$describe_1234)
  expect_close(d$sd, g$sd); expect_close(d$kurtosis, g$kurtosis)
})

test_that("describe matches the Python package on the claims sample", {
  d <- sc_describe(sc_sample("claims"))
  g <- split_df(golden()$describe_claims)
  expect_equal(d$column, g$column)
  for (c in c("n", "mean", "sd", "se", "cv", "min", "q1", "median", "q3", "max", "skewness", "kurtosis", "jarque_bera", "jb_p")) expect_close(d[[c]], g[[c]], 1e-9, c)
})

test_that("profile matches the Python package", {
  p <- sc_profile(sc_sample("claims"))
  g <- split_df(golden()$profile_claims)
  expect_equal(p$column, g$column)
  expect_equal(p$type, g$type)
  for (c in c("count", "missing", "unique", "min", "q1", "median", "mean", "q3", "max", "lo_fence", "hi_fence", "outliers")) expect_close(p[[c]], g[[c]], 1e-9, c)
})

test_that("jarque-bera separates a normal sample from a spike", {
  set.seed(0)
  expect_gt(sc_jarque_bera(rnorm(5000))[["p"]], 0.05)
  spike <- c(rep(0, 100), 50, 50, 50)
  expect_lt(sc_jarque_bera(spike)[["p"]], 0.001)
  expect_gt(sc_skew(spike), 1)
})

test_that("box statistics and the IQR = 0 rule", {
  b <- sc_box(c(1, 2, 3, 4, 100))
  expect_equal(b$q1, 2); expect_equal(b$q3, 4); expect_equal(b$hi_fence, 7); expect_equal(b$outliers, 100)
  expect_length(sc_box(c(5, 5, 5, 5, 9))$outliers, 0)
  expect_equal(sc_fences(c(1, 2, 3, 4, 100)), c(-1, 7))
})

test_that("column types follow the 80 % and date-probe rules", {
  expect_equal(sc_column_type(sprintf("2024-01-%02d", 1:12)), "date")
  expect_equal(sc_column_type(rep("01/02/2024", 12)), "string")
  expect_equal(sc_column_type(rep("2024-01-01", 5)), "string")
  expect_equal(sc_column_type(c("1", "2", "3", "4", "x")), "number")
  expect_equal(sc_column_type(c("1", "2", "x", "y", "z")), "string")
  t <- sc_types(sc_sample("dirty"))
  expect_equal(unname(t["age"]), "number")
  expect_equal(unname(t["premium_zar"]), "string")
})

test_that("tab, corr, outliers", {
  df <- sc_sample("claims")
  t <- sc_tab(df, "line")
  expect_equal(sum(t$pct), 100)
  expect_equal(sc_tab(df, "line", "sex")["Sum", "Sum"], 79)
  expect_true(nrow(sc_corr(df)) >= 3)
  expect_equal(nrow(sc_outliers(df, "paid")) + nrow(sc_inliers(df, "paid")), nrow(df))
})

test_that("scelo_table keeps its notes through subsetting and prints them", {
  t <- sc_table(data.frame(a = 1:5), title = "five", basis = "toy", notes = "a caveat")
  s <- t[t$a > 2, , drop = FALSE]
  expect_s3_class(s, "scelo_table")
  expect_equal(sc_notes(s), "a caveat")
  expect_equal(sc_basis(s), "toy")
  out <- capture.output(print(t))
  expect_true(any(grepl("a caveat", out)))
  expect_true(is.data.frame(sc_df(t)) && !inherits(sc_df(t), "scelo_table"))
  expect_match(sc_markdown(t), "### five")
})

test_that("the audit trail records tools", {
  sc_clear_audit()
  sc_describe(data.frame(x = 1:3))
  a <- sc_audit()
  expect_equal(a$fn, "sc_describe")
  expect_equal(a$in_shape, "3×1")
  sc_enable_audit(FALSE)
  sc_describe(data.frame(x = 1:3))
  expect_equal(nrow(sc_audit()), 1)
  sc_enable_audit(TRUE)
  expect_equal(nchar(sc_content_hash(data.frame(x = 1))), 32)
})

test_that("save round-trips csv and writes markdown", {
  df <- sc_sample("claims")
  p <- tempfile(fileext = ".csv")
  sc_save(df, p)
  expect_equal(dim(sc_load(p)), dim(df))
  m <- tempfile(fileext = ".md")
  sc_save(sc_profile(df), m)
  expect_true(any(grepl("### profile", readLines(m))))
})
