# Cleaning: the same cases as packages/scelo-py/tests/test_clean.py, plus
# the golden values computed by the Python package on the dirty sample.

test_that("parse_number follows the IDE's rules", {
  expect_equal(sc_parse_number("R 1,234.50"), 1234.5)
  expect_equal(sc_parse_number("(1,200)"), -1200)
  expect_equal(sc_parse_number("85%"), 85)
  expect_equal(sc_parse_number("1 200 ZAR"), 1200)
  expect_equal(sc_parse_number("$-3"), -3)
  expect_true(all(is.na(sc_parse_number(c("abc", "-", "")))))
  expect_equal(sc_parse_number("−5"), -5) # unicode minus
  expect_equal(sc_parse_number(c(3, NA, NaN)), c(3, NA, NA))
  expect_true(is.na(sc_parse_number(TRUE)))
  g <- golden()$parse_number
  got <- sc_parse_number(names(g))
  for (i in seq_along(g)) {
    if (is.null(g[[i]])) expect_true(is.na(got[i]), label = names(g)[i]) else expect_close(got[i], g[[i]], label = names(g)[i])
  }
})

test_that("parse_date follows the IDE's rules", {
  d <- function(x, ...) format(sc_parse_date(x, ...), "%Y-%m-%d")
  expect_equal(d("2024-01-05"), "2024-01-05")
  expect_equal(d("13/02/2024"), "2024-02-13") # a > 12 forces day-first
  expect_equal(d("02/13/2024"), "2024-02-13") # b > 12 forces month-first
  expect_true(is.na(sc_parse_date("13/13/2024")))
  expect_equal(d("05/06/2024"), "2024-05-06") # ambiguous: month-first by default
  expect_equal(d("05/06/2024", day_first = TRUE), "2024-06-05")
  expect_equal(d("Jan 5, 2024"), "2024-01-05")
  expect_equal(d("5 Jan 24"), "2024-01-05")
  expect_true(all(is.na(sc_parse_date(c("31/02/2024", "2024-13-01", "1650-01-01")))))
  expect_equal(format(sc_parse_date("2024-01-05 10:30:00"), "%H"), "10")
  expect_equal(format(sc_parse_date("2024-01-05T10:30:00+02:00"), "%Y-%m-%d %H:%M"), "2024-01-05 08:30") # offsets land in UTC
  expect_equal(format(sc_parse_date("2024-01-05T10:30Z"), "%H:%M"), "10:30")
  expect_s3_class(sc_parse_date("2024-01-05"), "POSIXct")
  expect_true(sc_infer_day_first(c("13/01/2024", "14/01/2024", "05/06/2024")))
  expect_false(sc_infer_day_first(c("01/13/2024", "05/06/2024")))
  g <- golden()$parse_date
  got <- d(names(g))
  for (i in seq_along(g)) {
    if (is.null(g[[i]])) expect_true(is.na(got[i]), label = names(g)[i]) else expect_equal(got[i], g[[i]], label = names(g)[i])
  }
})

test_that("snake_case", {
  expect_equal(sc_snake_case("Customer Name"), "customer_name")
  expect_equal(sc_snake_case("camelCaseHeader"), "camel_case_header")
  expect_true(is.na(sc_snake_case("already_snake")))
  expect_true(is.na(sc_snake_case("  ")))
  expect_equal(sc_snake_case(c("Joined Date", "it's (net)")), c("joined_date", "its_net"))
})

test_that("suggest on the dirty sample reproduces the Python plan", {
  dirty <- sc_sample("dirty")
  plan <- sc_suggest(dirty)
  expect_s3_class(plan, "scelo_table")
  expect_equal(names(plan), c("op", "title", "safe", "cells", "columns", "why"))
  want <- split_df(golden()$suggest_dirty)
  expect_equal(plan$op, want$op)
  expect_equal(plan$title, want$title)
  expect_equal(plan$safe, as.logical(want$safe))
  expect_equal(plan$cells, as.integer(want$cells))
  expect_equal(plan$columns, want$columns)
  expect_equal(plan$why, want$why)
  for (expected in c("fix-encoding", "missing-tokens", "parse-numeric", "parse-dates", "standardise-booleans", "replace-numeric-sentinels",
                     "drop-duplicates", "drop-empty-cols", "drop-constant-cols", "lowercase-categoricals", "rename-snake-case")) {
    expect_true(expected %in% plan$op, label = expected)
  }
  row <- function(op, col) plan[[col]][plan$op == op]
  expect_equal(row("drop-duplicates", "cells"), 3L)
  expect_true(grepl("notes", row("drop-empty-cols", "columns")) && grepl("internal_ref_v2", row("drop-empty-cols", "columns")))
  expect_equal(row("drop-constant-cols", "columns"), "country")
  expect_true(row("parse-numeric", "safe") && !row("drop-duplicates", "safe"))
  expect_equal(sc_title(plan), "cleaning plan · 12 op(s) · 53 rows × 11 cols")
  expect_equal(sc_notes(plan), "7 safe op(s) run with sc_clean(df); 5 need sc_clean(df, \"all\") or an explicit list.")
})

test_that("clean: safe then all, against the Python golden", {
  dirty <- sc_sample("dirty")
  g <- golden()$clean_dirty_safe
  c1 <- sc_clean(dirty)
  expect_s3_class(c1, "scelo_table")
  expect_equal(dim(c1), as.integer(g$shape)) # safe ops never drop rows or columns
  expect_true(is.numeric(c1$premium_zar) && is.numeric(c1$discount_pct))
  expect_s3_class(c1$`Joined Date`, "Date")
  expect_true(is.logical(c1$active))
  expect_close(sum(c1$premium_zar, na.rm = TRUE), g$premium_sum)
  expect_equal(sum(is.na(c1$age)), as.integer(g$age_null)) # -999 sentinels nulled
  expect_equal(sum(c1$age < 0, na.rm = TRUE), 0L)
  expect_equal(sum(c1$active, na.rm = TRUE), as.integer(g$active_true))
  expect_equal(sum(!is.na(c1$`Joined Date`)), as.integer(g$dates_parsed))
  expect_equal(sc_notes(c1), c(
    "fix encoding: 19 cells", "collapse internal whitespace: 7 cells", "null missing markers: 8 cells", "booleans: active", "dates: Joined Date",
    "numbers: premium_zar, discount_pct", "sentinels → null: age (6 cells)",
    "53×11 → 53×11 · clean: a further pass finds nothing more to do (7 unsafe op(s) available via sc_clean(df, \"all\"): drop-duplicates, drop-empty-cols, drop-constant-cols, lowercase-categoricals, cap-outliers, impute-missing, rename-snake-case)."
  ))
  expect_equal(sc_title(c1), "clean · 53 rows")
  g2 <- golden()$clean_dirty_all
  c2 <- sc_clean(dirty, "all")
  expect_equal(dim(c2), as.integer(g2$shape))
  expect_equal(names(c2), g2$columns)
  expect_false("country" %in% names(c2))
  expect_true("customer_name" %in% names(c2))
  expect_true(any(grepl("clean", sc_notes(c2))))
  expect_true(all(startsWith(utils::head(sc_notes(c2), -1), "pass ")))
  expect_equal(sc_notes(c2)[12:15], c(
    "pass 2 · outliers capped: age (1 values)",
    "pass 2 · imputed: email, premium_zar, age, active (23 cells, was_missing_* indicators added)",
    "pass 3 · outliers capped: age (1 values)",
    "53×11 → 50×12 · clean: a further pass finds nothing more to do."
  ))
  expect_equal(sum(c2$was_missing_email), 6L)
  expect_false(any(is.na(c2$age)))
  expect_equal(sum(is.na(c2$joined_date)), 3L) # dates are never imputed ("-", "" and "TBD" rows, after the duplicates went)
})

test_that("ops can be named, aliased and capped by passes", {
  dirty <- sc_sample("dirty")
  c3 <- sc_clean(dirty, c("dedupe", "snake"))
  expect_equal(nrow(c3), 50L)
  expect_true(all(c("customer_name", "joined_date") %in% names(c3)))
  expect_true(is.character(c3$premium_zar)) # parse-numeric was not enabled
  expect_equal(sc_notes(c3)[1:2], c("duplicates dropped: 3 rows", "headers snake_cased: 4"))
  expect_true(grepl("^53×11 → 50×11 · clean: a further pass finds nothing more to do \\(", sc_notes(c3)[3]))
  expect_equal(nrow(sc_clean(dirty, "drop_duplicates")), 50L)
  expect_error(sc_clean(dirty, "frobnicate"), "unknown cleaning op 'frobnicate': choose from fix-encoding")
  one <- sc_clean(dirty, "all", passes = 1)
  expect_equal(nrow(one), 50L)
  expect_true(grepl("1 pass\\(es\\) spent; [0-9]+ op\\(s\\) still apply, run again or inspect sc_suggest\\(\\)\\.$", utils::tail(sc_notes(one), 1)))
  expect_false(any(startsWith(sc_notes(one), "pass ")))
  expect_equal(sc_clean(dirty, "safe")$premium_zar, sc_clean(dirty)$premium_zar)
})

test_that("individual ops", {
  df <- data.frame(Name = c("  Ann  ", "Bob  Jr", "N/A", "Ã©lan"), v = c("1", "2", "x", "4"), stringsAsFactors = FALSE)
  expect_equal(sc_trim(df)$Name[1], "Ann")
  expect_equal(sc_collapse_ws(df)$Name[2], "Bob Jr")
  expect_true(is.na(sc_missing_tokens(df)$Name[3]))
  expect_equal(sc_fix_encoding(df)$Name[4], "élan")
  expect_equal(names(sc_snake_names(df)), c("name", "v"))
  expect_equal(names(sc_snake_names(data.frame(a_b = 1, `a b` = 2, check.names = FALSE))), c("a_b", "a b")) # collision: abandoned entirely
  num <- sc_coerce_numeric(data.frame(n = c("1", "2", "6+", "7", "8", "9", "10", "11", "12", "x"), stringsAsFactors = FALSE)) # >= 80 % numeric: a number column with residue
  expect_equal(num$n[1:5], c(1, 2, 6, 7, 8))
  expect_true(is.na(num$n[10]))
  untouched <- sc_coerce_numeric(data.frame(n = c("1", "2", "6+", "7", "8", "x"), stringsAsFactors = FALSE)) # 67 % numeric: still a string column
  expect_equal(untouched$n, c("1", "2", "6+", "7", "8", "x"))
  money <- sc_parse_numbers(data.frame(amt = c("R 1,234.50", "(1,200)", "85%", "1 200 ZAR", "n/a"), stringsAsFactors = FALSE))
  expect_equal(money$amt, c(1234.5, -1200, 85, 1200, NA))
  flags <- data.frame(flag = c("Y", "N", "yes", "no", "TRUE", "maybe", "x"), stringsAsFactors = FALSE)
  expect_equal(sc_booleans(flags)$flag, flags$flag) # "maybe" is 1 of 6 candidates: > 5 % other values, not a boolean column by the rule
  expect_equal(sc_booleans(flags, "flag")$flag, c(TRUE, FALSE, TRUE, FALSE, TRUE, NA, NA)) # named explicitly: "x" is a missing marker, not a false
  expect_equal(sc_booleans(data.frame(f = c("Y", "N", "Y", "N", "y"), stringsAsFactors = FALSE))$f, c(TRUE, FALSE, TRUE, FALSE, TRUE))
  dd <- sc_parse_dates(data.frame(d = c("13/01/2024", "14/01/2024", "05/06/2024", "Jan 5, 2024", "nope"), stringsAsFactors = FALSE))
  expect_s3_class(dd$d, "Date")
  expect_equal(format(dd$d), c("2024-01-13", "2024-01-14", "2024-06-05", "2024-01-05", NA)) # day-first inferred from the unambiguous cells
  expect_equal(sc_recode(df, "Name", "N/A", "none")$Name[3], "none")
  fy <- sc_future_years(data.frame(year = c(2001, 2099, 2030.5), x = c(2099, 1, 2)), max_year = 2030)
  expect_equal(fy$year, c(2001, NA, 2030.5))
  expect_equal(fy$x, c(2099, 1, 2))
  expect_equal(nrow(sc_dedupe(data.frame(a = c(1, 1, 2), b = c("x", "x", "y")))), 2L)
  expect_equal(names(sc_drop_empty(data.frame(a = 1:100, b = c(1, rep(NA, 99))))), "a")
  expect_equal(names(sc_drop_constant(data.frame(a = 1:3, b = c("z", "z", "z"), stringsAsFactors = FALSE))), "a")
  expect_equal(names(sc_drop_constant(data.frame(b = c("z", "z", "z")))), "b") # never all of them
  lc <- sc_lowercase(data.frame(r = c("WEST", "west", "West", "East"), stringsAsFactors = FALSE))
  expect_equal(lc$r, c("west", "west", "west", "east"))
})

test_that("impute rules and indicator", {
  df <- data.frame(x = c(1, 2, 3, 4, NA, 100), cat = c("a", "a", "a", "b", NA, "a"), id = c(1, 2, 3, 4, 5, NA), stringsAsFactors = FALSE)
  out <- sc_impute(df, c("x", "cat"))
  expect_equal(out$x[5], 3) # median of 1, 2, 3, 4, 100
  expect_equal(out$cat[5], "a")
  expect_equal(sum(out$was_missing_x), 1L)
  expect_equal(match("was_missing_x", names(out)), 2L)
  expect_equal(names(out), c("x", "was_missing_x", "cat", "was_missing_cat", "id"))
  dates <- data.frame(d = as.Date(c("2024-01-01", NA, "2024-01-03", "2024-01-04", "2024-01-05")))
  expect_equal(sum(is.na(sc_impute(dates)$d)), 1L) # dates are never filled in auto mode
  expect_equal(sc_impute(df, "x", strategy = "mean")$x[5], 22)
  expect_equal(sc_impute(df, "x", strategy = "value", value = -1, indicator = FALSE)$x[5], -1)
  expect_false("was_missing_x" %in% names(sc_impute(df, "x", indicator = FALSE)))
  ids <- data.frame(k = c(sprintf("id%d", 1:30), NA), stringsAsFactors = FALSE)
  expect_true(is.na(sc_impute(ids)$k[31])) # identifier-like: skipped
  expect_true(is.null(.sc_impute_skip(df$x, df$x[!is.na(df$x)], 1L)))
  expect_equal(.sc_impute_skip(ids$k, ids$k[!is.na(ids$k)], 1L), "reads as an identifier or free text")
})

test_that("cap outliers and sentinels", {
  df <- data.frame(x = c(1, 2, 3, 4, 5, 6, 7, 8, 9, 100), year = c(2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 9999))
  c <- sc_cap_outliers(df)
  expect_true(max(c$x) < 100)
  expect_equal(max(c$year), 9999) # year columns are never winsorised
  q <- stats::quantile(df$year, c(0.25, 0.75), names = FALSE)
  expect_equal(max(sc_cap_outliers(df, "year")$year), q[2] + 1.5 * (q[2] - q[1])) # explicit columns: fences applied regardless
  ages <- 25:64
  expect_equal(sum(is.na(sc_sentinels(data.frame(age = c(ages, -999, -999, -999)))$age)), 3L)
  expect_equal(sum(is.na(sc_sentinels(data.frame(age = c(ages, -999, -999)))$age)), 0L) # fewer than 3 occurrences: not a sentinel
  expect_equal(sum(is.na(sc_sentinels(data.frame(age = c(30, 31, 32, 33, 34, -999, -999, -999, 35, 36)))$age)), 0L) # 30 % sentinels pull the fences: the IDE leaves them too
  expect_equal(sum(is.na(sc_sentinels(data.frame(age = c(ages, -999, -999)), values = -999)$age)), 2L) # explicit values bypass the rule
})

test_that("clean is idempotent on clean data", {
  claims <- sc_sample("claims")
  once <- sc_clean(claims, "all")
  twice <- sc_clean(once, "all")
  expect_equal(dim(twice), dim(once))
  expect_true("Nothing to clean." %in% sc_notes(twice))
  expect_equal(sc_notes(once)[1:4], c(
    "pass 1 · booleans: settled", "pass 1 · outliers capped: paid (2 values)",
    "pass 1 · imputed: incurred (3 cells, was_missing_* indicators added)", "pass 2 · outliers capped: incurred (4 values)"
  ))
  plan <- sc_suggest(twice)
  expect_equal(nrow(plan), 0L)
  expect_equal(sc_notes(plan), "Nothing to clean: no op found anything to do.")
})

test_that("constants and the audit trail", {
  expect_equal(length(SC_ALL_OPS), 18L)
  expect_equal(SC_ALL_OPS[1:9], SC_SAFE_OPS)
  expect_true(all(c("n/a", "#n/a", "\u2014", "tbd") %in% SC_MISSING_TOKENS))
  expect_true("✓" %in% SC_TRUE_TOKENS && "x" %in% SC_FALSE_TOKENS)
  expect_true(all(c(-999, 9999, -1) %in% SC_NUMERIC_SENTINELS))
  sc_clear_audit()
  sc_clean(sc_sample("dirty"))
  expect_equal(utils::tail(sc_audit()$fn, 1), "sc_clean")
})

test_that("the analyser's shortcuts agree with the originals", {
  # column type from the uniques == sc_column_type on every sample column and some edge cases
  cols <- list()
  for (k in c("dirty", "claims", "climate", "lifelib-mp", "wmtr-scenarios")) {
    d <- sc_sample(k)
    for (c in names(d)) cols[[paste(k, c)]] <- d[[c]]
  }
  cols$all_na <- rep(NA_character_, 5)
  cols$empty <- c("", "", "")
  cols$iso <- c(sprintf("2024-01-%02d", 1:9), "x")
  cols$iso_short <- c("2024-01-01", "2024-01-02", "2024-01-03")
  cols$mostly_num <- c("1", "2", "3", "4", "6+")
  cols$leading_zero <- c("007", "008", "009", "010", "011")
  cols$factor <- factor(c("a", "b", "a", NA))
  cols$factor_blank <- factor(c("", "", "", "", "1", "2", "3", "4", NA))
  cols$blank_num <- c("", "", "", "", "1", "2", "3", "4", NA)
  cols$mixed <- c("1", "2", "x", "y", "z", NA, "")
  for (nm in names(cols)) expect_equal(.sc_str_info(cols[[nm]])$type, sc_column_type(cols[[nm]]), label = nm)
  # duplicate rows == duplicated() on frames with NA, NaN, -0, dates and factors
  x <- data.frame(v = c(NA, NaN, 0, -0, NA, 1), w = c("a", "a", "b", "b", "a", NA), d = as.Date("2024-01-01") + c(1, 1, 2, 2, 1, 1), f = factor(c("p", "p", "q", "q", "p", "p")))
  expect_equal(.sc_duplicated_rows(x), duplicated(x))
  expect_equal(.sc_duplicated_rows(x["w"]), duplicated(x["w"]))
  expect_equal(.sc_duplicated_rows(x[0, ]), logical(0))
  # missing mask == .sc_is_missing
  for (v in list(c("a", "", NA), c(1, NA, 3), as.Date(c("2024-01-01", NA)), c(TRUE, NA), factor(c("a", NA)), factor(c("", "a", NA)))) expect_equal(.sc_missing_mask(v), .sc_is_missing(v))
})
