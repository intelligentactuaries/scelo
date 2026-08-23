# Shared helpers for the scelo tests.
#
# py_golden.json holds values computed by the Python package (the reference
# implementation of the same maths); wmtr_fixture.json was generated from
# the TypeScript engine. Both packages are tested against the same numbers.

fixture_path <- function(name) {
  p <- testthat::test_path("fixtures", name)
  if (!file.exists(p)) p <- file.path("tests", "testthat", "fixtures", name)
  p
}

golden <- local({
  cache <- NULL
  function() {
    if (is.null(cache)) {
      skip_if_not_installed("jsonlite")
      cache <<- jsonlite::fromJSON(fixture_path("py_golden.json"), simplifyVector = TRUE)
    }
    cache
  }
})

# A pandas "split" JSON block (columns + data) → data.frame.
split_df <- function(block) {
  d <- block$data
  if (is.null(dim(d))) d <- matrix(d, ncol = length(block$columns))
  df <- as.data.frame(d, stringsAsFactors = FALSE)
  names(df) <- block$columns
  for (c in names(df)) {
    v <- df[[c]]
    if (is.list(v)) v <- vapply(v, function(x) if (is.null(x)) NA else x, FUN.VALUE = if (is.numeric(unlist(v))) numeric(1) else character(1))
    num <- suppressWarnings(as.numeric(v))
    if (is.character(v) && all(is.na(v) | !is.na(num))) v <- num
    df[[c]] <- v
  }
  df
}

expect_close <- function(a, b, tol = 1e-8, label = NULL) {
  a <- as.numeric(a); b <- as.numeric(b)
  ok <- is.na(a) == is.na(b)
  both <- !is.na(a) & !is.na(b)
  ok[both] <- abs(a[both] - b[both]) <= tol * pmax(1, abs(b[both]))
  testthat::expect(all(ok), sprintf("%s: max diff %.3g (tol %.1g)", label %||% "values", suppressWarnings(max(abs(a[both] - b[both]))), tol))
}

`%||%` <- function(a, b) if (is.null(a)) b else a
