# Reserving: triangles and the classical reserving methods, in base R.
#
# sc_triangle(df) builds an origin × development triangle from a claims file
# (columns inferred: origin / development or payment period / amount), exactly
# as Scelo IDE's run-off table does. sc_chain_ladder, sc_mack, sc_bf,
# sc_cape_cod and sc_bootstrap then work on the triangle, and sc_reserve(df)
# runs the lot in one line.
#
# The engine indexes purely by development *period*, like the IDE's numpy
# bridge (apps/web/src/components/Scelo/bridges/chainladderPython.ts): it does
# not infer development from calendar dates, so a development-truncated
# parallelogram does not grow phantom origins. Mack's standard error is the
# full 1993 formula including the inter-origin covariance term; the bootstrap
# is the over-dispersed Poisson (England & Verrall) with gamma process error.
#
# A triangle is a scelo_table whose rownames are the origins and whose column
# names are the development lags ("0", "1", ...), flagged with the attributes
# scelo_triangle = TRUE and cumulative = TRUE / FALSE. Every method also
# accepts a plain numeric matrix, or the long claims file itself.

# ── small shared helpers ────────────────────────────────────────────────────

# Python's f"{x:,.0f}" / f"{x:,.1f}": thousands separators, fixed decimals.
.sc_thousands <- function(x, digits = 0) formatC(x, format = "f", digits = digits, big.mark = ",")

# Python's f"{x:g}": six significant digits, no trailing zeros.
.sc_gnum <- function(x) trimws(formatC(x, format = "g", digits = 6))

.sc_nansum <- function(x) sum(x, na.rm = TRUE)

# Python's _period(): an origin / payment period as an integer year or index.
.sc_period <- function(v) {
  if (is.numeric(v)) return(as.integer(round(v)))
  if (inherits(v, c("Date", "POSIXt"))) return(as.integer(format(v, "%Y")))
  s <- trimws(as.character(v))
  out <- suppressWarnings(as.integer(round(as.numeric(s))))
  miss <- is.na(out) & !is.na(s)
  if (any(miss)) {
    four <- substr(s[miss], 1, 4)
    ok <- nchar(s[miss]) >= 4 & grepl("^[0-9]{4}$", four)
    out[miss] <- ifelse(ok, suppressWarnings(as.integer(four)), NA_integer_)
  }
  out
}

.sc_as_num <- function(v) {
  if (is.numeric(v)) return(as.numeric(v))
  if (is.logical(v)) return(as.numeric(v))
  suppressWarnings(as.numeric(as.character(v)))
}

# Run expr with R's RNG seeded (when seed is given) and the caller's RNG state
# put back afterwards, so a seeded simulation is reproducible without
# clobbering the session's random stream (numpy's default_rng(seed) is local).
.sc_with_seed <- function(seed, expr) {
  if (is.null(seed)) return(expr)
  had <- exists(".Random.seed", envir = globalenv(), inherits = FALSE)
  old <- if (had) get(".Random.seed", envir = globalenv(), inherits = FALSE) else NULL
  on.exit(if (had) assign(".Random.seed", old, envir = globalenv()) else suppressWarnings(rm(".Random.seed", envir = globalenv())), add = TRUE)
  set.seed(seed)
  expr
}

# Minimum-norm least squares (numpy.linalg.lstsq with rcond = None) via SVD.
.sc_lstsq <- function(X, y) {
  s <- svd(X)
  tol <- max(dim(X)) * max(s$d) * .Machine$double.eps
  pos <- s$d > tol
  if (!any(pos)) return(rep(0, ncol(X)))
  as.vector(s$v[, pos, drop = FALSE] %*% ((t(s$u[, pos, drop = FALSE]) %*% y) / s$d[pos]))
}

# ── triangle construction ───────────────────────────────────────────────────

.sc_is_triangle <- function(x) isTRUE(attr(x, "scelo_triangle"))

.sc_cumulate <- function(arr) {
  for (i in seq_len(nrow(arr))) {
    ok <- !is.na(arr[i, ])
    if (any(ok)) arr[i, ok] <- cumsum(arr[i, ok])
  }
  arr
}

.sc_decumulate <- function(arr) {
  for (i in seq_len(nrow(arr))) {
    ok <- !is.na(arr[i, ])
    if (any(ok)) arr[i, ok] <- diff(c(0, arr[i, ok]))
  }
  arr
}

# A triangle (scelo_table, data.frame or matrix) as a double matrix with the
# origins as rownames and the development lags as column names.
.sc_tri_matrix <- function(tri) {
  if (is.data.frame(tri)) {
    df <- if (inherits(tri, "scelo_table")) sc_df(tri) else tri
    bad <- names(df)[!vapply(df, is.numeric, logical(1))]
    if (length(bad)) stop(sprintf("triangle columns must be numeric (development lags): %s. Use sc_from_wide() for a wide file or sc_triangle() for a long one", paste(bad, collapse = ", ")), call. = FALSE)
    C <- as.matrix(df)
    dimnames(C) <- list(rownames(df), names(df))
  } else {
    C <- as.matrix(tri)
    if (is.null(rownames(C))) rownames(C) <- as.character(seq_len(nrow(C)) - 1L)
    if (is.null(colnames(C))) colnames(C) <- as.character(seq_len(ncol(C)) - 1L)
  }
  storage.mode(C) <- "double"
  C
}

.sc_wrap_triangle <- function(C, title, cumulative, basis = NULL, notes = character()) {
  t <- sc_table(as.data.frame(C, stringsAsFactors = FALSE), title = title, basis = basis, notes = notes, stage = "hard")
  attr(t, "scelo_triangle") <- TRUE
  attr(t, "cumulative") <- cumulative
  t
}

# A long claims file (has an origin-ish column) rather than a wide triangle.
.sc_looks_long <- function(df) is.data.frame(df) && !is.null(sc_infer(df, "origin", required = FALSE))

# Long file → triangle; anything already triangle-shaped passes through.
.sc_as_triangle <- function(tri) {
  if (is.data.frame(tri) && !.sc_is_triangle(tri) && .sc_looks_long(tri)) sc_triangle(tri) else tri
}

.sc_cum <- function(tri) {
  C <- .sc_tri_matrix(tri)
  if (sc_is_cumulative(tri)) C else .sc_cumulate(C)
}

#' Origin × development triangle from a long claims file
#'
#' Rows are summed per (origin, lag), the columns inferred by alias when not
#' given. `dev` is an integer lag column; or give `payment` (a calendar
#' period) and lag = payment − origin. Input rows are INCREMENTAL amounts by
#' default and are accumulated along development (`cumulative = TRUE`); pass
#' `incremental_input = FALSE` when the file already holds cumulative
#' figures. Cells beyond the latest observed diagonal are `NA`; cells inside
#' it with no claims are 0.
#'
#' The result is a `scelo_table` with the origins as rownames and the
#' development lags as column names (`"0"`, `"1"`, ...), carrying the
#' attributes `scelo_triangle = TRUE` and `cumulative`. A triangle passed in
#' is returned unchanged.
#'
#' @param df A long claims data frame (or an existing triangle).
#' @param origin Origin-period column (inferred: origin, accident_year, ay, ...).
#' @param dev Development-lag column (inferred: dev, lag, development_period, ...).
#' @param value Amount column (inferred: paid, incurred, amount, ...).
#' @param payment Calendar-period column used when there is no lag column.
#' @param cumulative Return a cumulative (`TRUE`) or incremental triangle.
#' @param incremental_input Whether the input rows are incremental amounts.
#' @return A `scelo_table` triangle.
#' @examples
#' tri <- sc_triangle(sc_sample("claims"))
#' tri
#' sc_triangle(sc_sample("claims"), cumulative = FALSE)
#' @export
sc_triangle <- function(df, origin = NULL, dev = NULL, value = NULL, payment = NULL, cumulative = TRUE, incremental_input = TRUE) {
  if (.sc_is_triangle(df)) return(df)
  .sc_tool("sc_triangle", Filter(Negate(is.null), list(origin = origin, dev = dev, value = value, payment = payment, cumulative = cumulative, incremental_input = incremental_input)), df, {
    o <- sc_infer(df, "origin", origin)
    v <- sc_infer(df, "value", value, exclude = o)
    d <- NULL
    if (!is.null(dev) || is.null(payment)) d <- sc_infer(df, "development", dev, required = FALSE, exclude = c(o, v))
    p <- NULL
    if (is.null(d)) {
      p <- sc_infer(df, "payment", payment, required = FALSE, exclude = c(o, v))
      if (is.null(p)) stop("need a development-lag column (dev=) or a payment-period column (payment=)", call. = FALSE)
    }
    origins <- .sc_period(df[[o]])
    vals <- .sc_as_num(df[[v]])
    lags <- if (!is.null(d)) round(.sc_as_num(df[[d]])) else .sc_period(df[[p]]) - origins
    keep <- !is.na(origins) & !is.na(vals) & !is.na(lags) & lags >= 0
    skipped <- sum(!keep)
    if (!any(keep)) stop("no (origin, development, value) triples could be read", call. = FALSE)
    og <- origins[keep]
    lg <- as.integer(lags[keep])
    orig_levels <- sort(unique(og))
    lag_levels <- seq(min(lg), max(lg))
    wide <- tapply(vals[keep], list(factor(og, levels = orig_levels), factor(lg, levels = lag_levels)), sum)
    arr <- matrix(as.numeric(wide), length(orig_levels), length(lag_levels))
    # Fill inside the observed region with 0 (no claims that period), leave the future NA.
    latest <- max(og + lg)
    arr[is.na(arr) & outer(orig_levels, lag_levels, "+") <= latest] <- 0
    if (incremental_input && cumulative) {
      arr <- .sc_cumulate(arr)
    } else if (!incremental_input && !cumulative) {
      arr <- .sc_decumulate(arr)
    }
    dimnames(arr) <- list(as.character(orig_levels), as.character(lag_levels))
    notes <- c(
      sprintf("%d origin periods × %d development lags, summed from %s rows%s. Input rows treated as %s amounts.", nrow(arr), ncol(arr), format(nrow(df), big.mark = ","),
              if (skipped) sprintf(" (%d rows skipped: unreadable origin / lag / value)", skipped) else "", if (incremental_input) "incremental" else "cumulative"),
      if (!is.null(p)) sprintf("Development lag = %s − %s.", p, o) else sprintf("Development lag read from `%s`.", d)
    )
    .sc_wrap_triangle(arr, title = sprintf("%s triangle · %s by %s × development", if (cumulative) "Cumulative" else "Incremental", v, o),
                      cumulative = cumulative, basis = sprintf("%s · %s × dev", v, o), notes = notes)
  })
}

#' Wrap an already-wide triangle
#'
#' Rows are origins, columns are development lags 0 .. n−1. A matrix (or a
#' list of row vectors) takes its origins from `origins`, its rownames or
#' 0 .. n−1; a data frame keeps its column labels when they are integers
#' (`"dev 1"` reads as 1) and otherwise relabels them 0 .. n−1, and a column
#' named like an origin (`origin`, `accident_year`, ...) supplies the origins.
#'
#' @param data A numeric matrix, list of rows or data frame.
#' @param origins Origin labels, one per row.
#' @param cumulative Whether the figures are cumulative.
#' @return A `scelo_table` triangle.
#' @examples
#' sc_from_wide(rbind(c(100, 150, 175), c(110, 160, NA), c(120, NA, NA)), origins = 2019:2021)
#' @export
sc_from_wide <- function(data, origins = NULL, cumulative = TRUE) {
  if (is.data.frame(data)) {
    df <- data
    if (is.null(origins)) {
      oc <- sc_find_column(names(df), SC_COLUMN_ALIASES$origin)
      if (!is.null(oc)) {
        origins <- df[[oc]]
        df[[oc]] <- NULL
      } else {
        origins <- if (.row_names_info(df) < 0) seq_len(nrow(df)) - 1L else rownames(df)
      }
    }
    labels <- sub("^[dev ]+", "", as.character(names(df)))
    if (!all(grepl("^[0-9]+$", labels))) labels <- as.character(seq_len(ncol(df)) - 1L)
    C <- as.matrix(df)
  } else {
    C <- if (is.list(data)) do.call(rbind, lapply(data, as.numeric)) else as.matrix(data)
    if (is.null(origins)) origins <- if (!is.null(rownames(C))) rownames(C) else seq_len(nrow(C)) - 1L
    labels <- as.character(seq_len(ncol(C)) - 1L)
  }
  if (length(origins) != nrow(C)) stop(sprintf("origins must have one label per row (%d), got %d", nrow(C), length(origins)), call. = FALSE)
  storage.mode(C) <- "double"
  dimnames(C) <- list(as.character(origins), labels)
  .sc_wrap_triangle(C, title = sprintf("%s triangle", if (cumulative) "Cumulative" else "Incremental"), cumulative = cumulative)
}

#' Cumulative and incremental triangles
#'
#' `sc_is_cumulative()` reads the triangle's `cumulative` attribute, or for a
#' plain matrix checks that no row ever decreases. `sc_to_incremental()` and
#' `sc_to_cumulative()` convert (and return the input unchanged when it is
#' already in that form).
#'
#' @param tri A triangle (see [sc_triangle()]) or a numeric matrix.
#' @return A logical for `sc_is_cumulative()`; a triangle otherwise.
#' @examples
#' tri <- sc_triangle(sc_sample("claims"))
#' sc_is_cumulative(tri)
#' sc_to_incremental(tri)
#' @export
sc_is_cumulative <- function(tri) {
  if (.sc_is_triangle(tri)) return(isTRUE(attr(tri, "cumulative") %||% TRUE))
  C <- .sc_tri_matrix(tri)
  if (ncol(C) < 2) return(TRUE)
  d <- C[, -1, drop = FALSE] - C[, -ncol(C), drop = FALSE]
  d <- d[is.finite(d)]
  !length(d) || min(d) >= 0
}

#' @rdname sc_is_cumulative
#' @export
sc_to_incremental <- function(tri) {
  if (!sc_is_cumulative(tri)) return(tri)
  .sc_wrap_triangle(.sc_decumulate(.sc_tri_matrix(tri)), title = "Incremental triangle", cumulative = FALSE)
}

#' @rdname sc_is_cumulative
#' @export
sc_to_cumulative <- function(tri) {
  if (sc_is_cumulative(tri)) return(tri)
  .sc_wrap_triangle(.sc_cumulate(.sc_tri_matrix(tri)), title = "Cumulative triangle", cumulative = TRUE)
}

#' Latest diagonal
#'
#' The latest cumulative value per origin (the paid-to-date).
#' @param tri A triangle or numeric matrix.
#' @return A named numeric vector, one value per origin.
#' @examples
#' sc_latest_diagonal(sc_triangle(sc_sample("claims")))
#' @export
sc_latest_diagonal <- function(tri) {
  tri <- .sc_as_triangle(tri)
  C <- .sc_cum(tri)
  pr <- .sc_project(C, rep(1, max(ncol(C) - 1L, 0L)))
  stats::setNames(pr$latest, rownames(C))
}

# ── development factors ─────────────────────────────────────────────────────

# Age-to-age factors with Mack's σ² and the column volumes S_k.
.sc_factors <- function(C, average = "volume", n_periods = NULL) {
  n_d <- ncol(C)
  m <- max(n_d - 1L, 0L)
  f <- rep(1, m)
  sig2 <- numeric(m)
  S <- numeric(m)
  nk <- integer(m)
  for (k in seq_len(m)) {
    a <- C[, k]
    b <- C[, k + 1L]
    ok <- which(is.finite(a) & is.finite(b) & a != 0)
    if (!is.null(n_periods) && length(ok) > n_periods) ok <- ok[seq(length(ok) - n_periods + 1L, length(ok))]
    if (!length(ok)) next
    a <- a[ok]
    b <- b[ok]
    f[k] <- switch(average, simple = mean(b / a), regression = sum(a * b) / sum(a * a), sum(b) / sum(a))
    S[k] <- sum(a)
    nk[k] <- length(ok)
    if (length(ok) >= 2) sig2[k] <- sum(a * (b / a - f[k])^2) / (length(ok) - 1)
  }
  # Mack's tail σ² convention for the last factor when it has < 2 observations
  for (k in seq_len(m)) {
    if (nk[k] < 2) {
      if (k >= 3 && sig2[k - 2] > 0) {
        sig2[k] <- min(sig2[k - 1]^2 / sig2[k - 2], sig2[k - 2], sig2[k - 1])
      } else if (k >= 2) {
        sig2[k] <- sig2[k - 1]
      }
    }
  }
  list(f = f, sigma2 = sig2, S = S, n = nk)
}

# Latest, last observed column (1-based), cdf and ultimate per origin under factors f (with tail).
.sc_project <- function(C, f, tail_factor = 1) {
  n_o <- nrow(C)
  cdf_ <- rev(cumprod(rev(c(f, tail_factor))))
  fin <- is.finite(C)
  last_k <- rep(1L, n_o)
  latest <- rep(NA_real_, n_o)
  for (i in seq_len(n_o)) {
    w <- which(fin[i, ])
    if (length(w)) {
      last_k[i] <- w[length(w)]
      latest[i] <- C[i, last_k[i]]
    }
  }
  list(latest = latest, last_k = last_k, cdf = cdf_, ult = latest * cdf_[last_k])
}

.sc_dev_names <- function(devs) sprintf("%s→%s", devs[-length(devs)], devs[-1])

#' Age-to-age factors
#'
#' One row per origin plus the volume-weighted and simple averages; columns
#' are the development steps (`0→1`, `1→2`, ...).
#' @param tri A triangle, numeric matrix or long claims file.
#' @return A `scelo_table` (rownames: origins, then `volume-weighted` and `simple average`).
#' @examples
#' sc_ata(sc_triangle(sc_sample("claims")))
#' @export
sc_ata <- function(tri) {
  tri <- .sc_as_triangle(tri)
  C <- .sc_cum(tri)
  n_d <- ncol(C)
  if (n_d < 2) stop("a triangle needs at least two development lags for age-to-age factors", call. = FALSE)
  a <- C[, -n_d, drop = FALSE]
  b <- C[, -1, drop = FALSE]
  R <- b / a
  R[!(is.finite(a) & is.finite(b) & a != 0)] <- NA_real_
  out <- rbind(R, `volume-weighted` = .sc_factors(C, "volume")$f, `simple average` = .sc_factors(C, "simple")$f)
  colnames(out) <- .sc_dev_names(colnames(C))
  sc_table(as.data.frame(out, stringsAsFactors = FALSE), title = "Age-to-age factors", stage = "hard")
}

#' Link ratios and cumulative development factors
#'
#' `sc_ldf()` gives the selected link ratios f_k (`average` = volume /
#' simple / regression; `n_periods` = latest n origins only) with a tail;
#' `sc_cdf()` the cumulative factors to ultimate, one per development lag.
#' @param tri A triangle, numeric matrix or long claims file.
#' @param average `"volume"` (weighted), `"simple"` or `"regression"`.
#' @param n_periods Use only the latest `n_periods` origins per factor.
#' @param tail_factor Tail factor beyond the last observed lag.
#' @return A named numeric vector (`0→1`, ..., `tail` for `sc_ldf()`; the lags for `sc_cdf()`).
#' @examples
#' tri <- sc_triangle(sc_sample("claims"))
#' sc_ldf(tri)
#' sc_cdf(tri)
#' @export
sc_ldf <- function(tri, average = "volume", n_periods = NULL, tail_factor = 1) {
  tri <- .sc_as_triangle(tri)
  C <- .sc_cum(tri)
  f <- .sc_factors(C, average, n_periods)$f
  stats::setNames(c(f, tail_factor), c(if (ncol(C) >= 2) .sc_dev_names(colnames(C)) else character(), "tail"))
}

#' @rdname sc_ldf
#' @export
sc_cdf <- function(tri, average = "volume", n_periods = NULL, tail_factor = 1) {
  tri <- .sc_as_triangle(tri)
  f <- unname(sc_ldf(tri, average, n_periods, tail_factor))
  cdf_ <- rev(cumprod(rev(f)))
  stats::setNames(cdf_, colnames(.sc_tri_matrix(tri))[seq_along(cdf_)])
}

# ── result type ─────────────────────────────────────────────────────────────

.sc_reserving <- function(method, table, ibnr, ultimate, latest, factors = numeric(), cdf = numeric(), se = NULL, cv = NULL, detail = list()) {
  structure(list(method = method, table = table, ibnr = ibnr, ultimate = ultimate, latest = latest, factors = factors, cdf = cdf, se = se, cv = cv, detail = detail),
            class = c("scelo_reserving", "list"))
}

#' Reserving results
#'
#' Every reserving method returns a `scelo_reserving` list: `method`, `table`
#' (the per-origin `scelo_table` with an `origin` column and a `total` row),
#' `ibnr`, `ultimate`, `latest`, `factors`, `cdf`, `se`, `cv` and `detail`.
#' Printing shows the headline line then the table; `summary()` gives a
#' one-row data frame (method, latest, ultimate, ibnr and, where the method
#' has one, se and cv).
#'
#' @param x,object A `scelo_reserving` result.
#' @param ... Passed on to the table's print method; ignored by `summary()`.
#' @return `print()` returns `x` invisibly; `summary()` a one-row data frame.
#' @name scelo_reserving
#' @examples
#' cl <- sc_chain_ladder(sc_sample("claims"))
#' cl
#' summary(cl)
NULL

#' @rdname scelo_reserving
#' @export
print.scelo_reserving <- function(x, ...) {
  head <- sprintf("%s: IBNR %s · ultimate %s · latest %s", x$method, .sc_thousands(x$ibnr), .sc_thousands(x$ultimate), .sc_thousands(x$latest))
  if (!is.null(x$se)) head <- paste0(head, sprintf(" · SE %s (CV %s)", .sc_thousands(x$se), if (is.null(x$cv) || is.na(x$cv)) "NA" else sprintf("%.1f%%", 100 * x$cv)))
  cat(head, "\n", sep = "")
  print(x$table, ...)
  invisible(x)
}

#' @rdname scelo_reserving
#' @export
summary.scelo_reserving <- function(object, ...) {
  s <- data.frame(method = object$method, latest = object$latest, ultimate = object$ultimate, ibnr = object$ibnr, stringsAsFactors = FALSE)
  if (!is.null(object$se)) {
    s$se <- object$se
    s$cv <- if (is.null(object$cv)) NA_real_ else object$cv
  }
  s
}

# Per-origin reserve table with a "total" row (column sums, NA-skipping).
.sc_res_table <- function(idx, latest, ult, extra = NULL, last_k = NULL, cdf_ = NULL) {
  out <- data.frame(origin = as.character(idx), latest = latest, ultimate = ult, ibnr = ult - latest, stringsAsFactors = FALSE)
  if (!is.null(last_k) && !is.null(cdf_)) {
    out <- data.frame(origin = out$origin, latest = out$latest, cdf = cdf_[last_k], pct_developed = 1 / cdf_[last_k], ultimate = out$ultimate, ibnr = out$ibnr, stringsAsFactors = FALSE)
  }
  for (nm in names(extra)) out[[nm]] <- extra[[nm]]
  total <- out[1, , drop = FALSE]
  total$origin <- "total"
  for (nm in names(out)[-1]) total[[nm]] <- if (nm %in% c("cdf", "pct_developed")) NA_real_ else .sc_nansum(out[[nm]])
  out <- rbind(out, total)
  rownames(out) <- NULL
  out
}

# ── methods ─────────────────────────────────────────────────────────────────

#' Chain ladder
#'
#' Volume-weighted link ratios, CDF to ultimate, IBNR = ultimate − latest.
#' A long claims file is turned into a triangle first.
#' @param tri A triangle (see [sc_triangle()]), numeric matrix or long claims file.
#' @param average `"volume"` (weighted), `"simple"` or `"regression"` link ratios.
#' @param n_periods Use only the latest `n_periods` origins per factor.
#' @param tail_factor Tail factor beyond the last observed lag.
#' @return A [scelo_reserving] result (method `"chain-ladder"`).
#' @examples
#' sc_chain_ladder(sc_sample("claims"))
#' @export
sc_chain_ladder <- function(tri, average = "volume", n_periods = NULL, tail_factor = 1) {
  .sc_tool("sc_chain_ladder", Filter(Negate(is.null), list(average = average, n_periods = n_periods, tail_factor = tail_factor)), tri, {
    tri <- .sc_as_triangle(tri)
    C <- .sc_cum(tri)
    fx <- .sc_factors(C, average, n_periods)
    pr <- .sc_project(C, fx$f, tail_factor)
    basis <- paste0(sprintf("%s-weighted link ratios", average), if (!is.null(n_periods)) sprintf(" · last %s", format(n_periods)) else "",
                    if (tail_factor != 1) sprintf(" · tail %s", format(tail_factor)) else "")
    table <- sc_table(.sc_res_table(rownames(C), pr$latest, pr$ult, last_k = pr$last_k, cdf_ = pr$cdf), title = "Chain ladder", basis = basis, stage = "hard",
                      notes = "f_k = Σ C(o,k+1) / Σ C(o,k) over origins with both cells; CDF_k = Π f_j (j ≥ k); ultimate = latest × CDF.")
    .sc_reserving("chain-ladder", table, .sc_nansum(pr$ult - pr$latest), .sc_nansum(pr$ult), .sc_nansum(pr$latest), fx$f, pr$cdf,
                  detail = list(sigma2 = fx$sigma2, S = fx$S))
  })
}

#' Mack chain ladder
#'
#' Mack (1993): the chain-ladder point estimate with the full MSE (process +
#' parameter error and the inter-origin covariance term).
#' σ̂²_k = Σ C(o,k)(C(o,k+1)/C(o,k) − f̂_k)² / (n_k − 1); the last σ² uses
#' Mack's extrapolation min(σ⁴_(k−1)/σ²_(k−2), σ²_(k−2), σ²_(k−1)).
#' Per-origin MSE and the total with the covariance term; SE = √MSE,
#' CV = SE / IBNR.
#' @inheritParams sc_chain_ladder
#' @return A [scelo_reserving] result (method `"mack"`) with `se`, `cv` and
#'   `detail$mse_by_origin`.
#' @examples
#' sc_mack(sc_sample("claims"))
#' @export
sc_mack <- function(tri, average = "volume", tail_factor = 1) {
  .sc_tool("sc_mack", list(average = average, tail_factor = tail_factor), tri, {
    tri <- .sc_as_triangle(tri)
    C <- .sc_cum(tri)
    n_o <- nrow(C)
    n_d <- ncol(C)
    fx <- .sc_factors(C, average)
    f <- fx$f
    sig2 <- fx$sigma2
    S <- fx$S
    pr <- .sc_project(C, f, tail_factor)
    latest <- pr$latest
    last_k <- pr$last_k
    cdf_ <- pr$cdf
    ult <- pr$ult
    # completed triangle Ĉ
    Chat <- C
    for (k in seq_len(n_d)[-1]) {
      rows <- last_k < k
      if (any(rows)) Chat[rows, k] <- Chat[rows, k - 1] * f[k - 1]
    }
    m <- n_d - 1L
    valid <- if (m > 0) f != 0 & S > 0 else logical()
    term <- ifelse(valid, sig2 / f^2, 0)
    mse_i <- numeric(n_o)
    if (m > 0) {
      K <- matrix(seq_len(m), n_o, m, byrow = TRUE)
      A <- Chat[, seq_len(m), drop = FALSE]
      T <- matrix(term, n_o, m, byrow = TRUE)
      Sm <- matrix(S, n_o, m, byrow = TRUE)
      V <- matrix(valid, n_o, m, byrow = TRUE)
      use <- K >= last_k & V & is.finite(A) & A != 0
      acc <- rowSums(ifelse(use, T * (1 / A + 1 / Sm), 0))
      mse_i <- ifelse(is.finite(ult), ult^2 * acc, 0)
    }
    total <- sum(mse_i)
    if (m > 0 && n_o > 1) {
      term2 <- ifelse(valid, term / S, 0)
      sfx <- c(rev(cumsum(rev(term2))), 0)  # sfx[k] = Σ_{j ≥ k} term2_j, sfx[n_d] = 0
      KK <- outer(last_k, last_k, pmax)
      U <- outer(ult, ult)
      U[!is.finite(U)] <- 0
      M <- matrix(sfx[KK], n_o, n_o)
      total <- total + sum(2 * U * M * upper.tri(M))
    }
    ibnr <- .sc_nansum(ult - latest)
    se <- sqrt(max(total, 0))
    se_i <- sqrt(pmax(mse_i, 0))
    res_i <- ult - latest
    cv_i <- ifelse(!is.na(res_i) & res_i > 0, se_i / ifelse(!is.na(res_i) & res_i > 0, res_i, 1), NA_real_)
    tab <- .sc_res_table(rownames(C), latest, ult, list(se = se_i, cv = cv_i), last_k, cdf_)
    tab$se[nrow(tab)] <- se
    tab$cv[nrow(tab)] <- if (ibnr != 0) se / ibnr else NA_real_
    table <- sc_table(tab, title = "Mack chain ladder", basis = sprintf("%s-weighted link ratios · Mack (1993) MSE", average), stage = "hard",
                      notes = "SE is the square root of Mack's MSE: process + estimation error per origin, plus the inter-origin covariance in the total. ±1.96·SE is a normal-approximation interval, not a tail quantile.")
    .sc_reserving("mack", table, ibnr, .sc_nansum(ult), .sc_nansum(latest), f, cdf_, se = se, cv = if (ibnr != 0) se / ibnr else NULL,
                  detail = list(sigma2 = sig2, S = S, mse_by_origin = mse_i))
  })
}

#' Bornhuetter–Ferguson
#'
#' Reserve = a-priori ultimate × (1 − 1/CDF). The a-priori ultimate per
#' origin comes from, in order: `apriori` (a number, a per-origin vector, or
#' a chain-ladder result whose ultimates seed it), `premium × elr`, or the
#' book-average chain-ladder ultimate (the IDE's standalone default: a flat
#' ELR would cancel back to CL).
#' @inheritParams sc_chain_ladder
#' @param apriori A number, a vector (one per origin) or a [scelo_reserving] result.
#' @param premium Premium per origin (used with `elr`).
#' @param elr Expected loss ratio applied to `premium`.
#' @return A [scelo_reserving] result (method `"bornhuetter-ferguson"`).
#' @examples
#' tri <- sc_triangle(sc_sample("claims"))
#' sc_bf(tri, apriori = sc_chain_ladder(tri))
#' sc_bf(tri, apriori = 500000)
#' @export
sc_bf <- function(tri, apriori = NULL, premium = NULL, elr = NULL, average = "volume", tail_factor = 1) {
  .sc_tool("sc_bf", Filter(Negate(is.null), list(apriori = apriori, premium = premium, elr = elr, average = average, tail_factor = tail_factor)), tri, {
    tri <- .sc_as_triangle(tri)
    C <- .sc_cum(tri)
    n_o <- nrow(C)
    fx <- .sc_factors(C, average)
    pr <- .sc_project(C, fx$f, tail_factor)
    if (inherits(apriori, "scelo_reserving")) {
      tab <- apriori$table
      prior <- as.numeric(tab$ultimate[tab$origin != "total"])
      source <- sprintf("%s ultimates", apriori$method)
    } else if (!is.null(apriori) && length(apriori) == 1) {
      prior <- rep(as.numeric(apriori), n_o)
      source <- "given a-priori"
    } else if (!is.null(apriori)) {
      prior <- as.numeric(apriori)
      source <- "given a-priori per origin"
    } else if (!is.null(premium) && !is.null(elr)) {
      prior <- as.numeric(premium) * as.numeric(elr)
      source <- sprintf("premium × ELR %.2f%%", 100 * elr)
    } else {
      prior <- rep(mean(pr$ult, na.rm = TRUE), n_o)
      source <- "book-average chain-ladder ultimate"
    }
    if (length(prior) != n_o) stop(sprintf("a-priori ultimates must have one value per origin (%d), got %d", n_o, length(prior)), call. = FALSE)
    pct_unrep <- 1 - 1 / pr$cdf[pr$last_k]
    res <- prior * pct_unrep
    ult <- pr$latest + res
    tab <- .sc_res_table(rownames(C), pr$latest, ult, list(apriori = prior, pct_unreported = pct_unrep), pr$last_k, pr$cdf)
    tab$pct_unreported[nrow(tab)] <- NA_real_
    table <- sc_table(tab, title = "Bornhuetter–Ferguson", basis = sprintf("a-priori: %s", source), stage = "hard",
                      notes = "Reserve = a-priori ultimate × (1 − 1/CDF): the expected unreported share of the prior, unmoved by the latest diagonal.")
    .sc_reserving("bornhuetter-ferguson", table, .sc_nansum(res), .sc_nansum(ult), .sc_nansum(pr$latest), fx$f, pr$cdf, detail = list(apriori_source = source))
  })
}

#' Cape Cod
#'
#' Stanard–Bühlmann: ELR = Σ latest / Σ (premium × %developed), then
#' Bornhuetter–Ferguson with that ELR.
#' @inheritParams sc_chain_ladder
#' @param premium Premium per origin.
#' @return A [scelo_reserving] result (method `"cape-cod"`) with `detail$elr`.
#' @examples
#' sc_cape_cod(sc_triangle(sc_sample("claims")), premium = rep(800000, 7))
#' @export
sc_cape_cod <- function(tri, premium, average = "volume", tail_factor = 1) {
  .sc_tool("sc_cape_cod", list(premium = premium, average = average, tail_factor = tail_factor), tri, {
    tri <- .sc_as_triangle(tri)
    C <- .sc_cum(tri)
    fx <- .sc_factors(C, average)
    pr <- .sc_project(C, fx$f, tail_factor)
    prem <- as.numeric(premium)
    if (length(prem) != nrow(C)) stop(sprintf("premium must have one value per origin (%d), got %d", nrow(C), length(prem)), call. = FALSE)
    used <- prem / pr$cdf[pr$last_k]
    elr <- .sc_nansum(pr$latest) / .sc_nansum(used)
    res <- prem * elr * (1 - 1 / pr$cdf[pr$last_k])
    ult <- pr$latest + res
    table <- sc_table(.sc_res_table(rownames(C), pr$latest, ult, list(premium = prem, used_premium = used), pr$last_k, pr$cdf), title = "Cape Cod", stage = "hard",
                      basis = sprintf("ELR %.2f%% from used-up premium", 100 * elr),
                      notes = "ELR = Σ latest / Σ (premium / CDF), one loss ratio for the book; reserve = premium × ELR × (1 − 1/CDF).")
    .sc_reserving("cape-cod", table, .sc_nansum(res), .sc_nansum(ult), .sc_nansum(pr$latest), fx$f, pr$cdf, detail = list(elr = elr))
  })
}

#' ODP bootstrap
#'
#' England & Verrall: resample the scaled Pearson residuals of the
#' incremental over-dispersed Poisson fit, refit each pseudo-triangle by
#' chain ladder, project, and add gamma process error. Returns the mean
#' reserve with SE and the p5 / p50 / p75 / p95 / p99 quantiles of the total
#' in `detail` (and the simulated totals in `detail$totals`, per origin in
#' `detail$by_origin`). Uses R's RNG: `seed` makes a run reproducible (the
#' session's RNG state is restored afterwards).
#' @inheritParams sc_chain_ladder
#' @param n Number of simulations.
#' @param seed Seed for R's RNG, or `NULL` to continue the session's stream.
#' @param process Add gamma process error (`TRUE`) or estimation error only.
#' @return A [scelo_reserving] result (method `"bootstrap"`).
#' @examples
#' sc_bootstrap(sc_triangle(sc_sample("claims")), n = 200, seed = 1)
#' @export
sc_bootstrap <- function(tri, n = 1000, seed = 42, process = TRUE, average = "volume") {
  .sc_tool("sc_bootstrap", Filter(Negate(is.null), list(n = n, seed = seed, process = process, average = average)), tri, {
    tri <- .sc_as_triangle(tri)
    C <- .sc_cum(tri)
    n_o <- nrow(C)
    n_d <- ncol(C)
    n <- as.integer(n)
    fx <- .sc_factors(C, average)
    f <- fx$f
    pr <- .sc_project(C, f)
    latest <- pr$latest
    last_k <- pr$last_k
    cdf_ <- pr$cdf
    K <- matrix(seq_len(n_d), n_o, n_d, byrow = TRUE)
    # fitted cumulative (backwards from ultimate) and incremental
    Chat <- outer(pr$ult, 1 / cdf_)
    Chat[K > last_k] <- NA_real_
    m_hat <- Chat - cbind(0, Chat[, -n_d, drop = FALSE])
    m_obs <- C - cbind(0, C[, -n_d, drop = FALSE])
    mask <- is.finite(m_obs) & is.finite(m_hat) & m_hat > 0
    res <- (m_obs[mask] - m_hat[mask]) / sqrt(m_hat[mask])
    n_obs <- sum(mask)
    dof <- max(n_obs - (n_o + n_d - 1), 1)
    phi <- sum(res^2) / dof
    res_adj <- res * sqrt(n_obs / dof)
    sqrt_mhat <- sqrt(m_hat[mask])
    obs_na <- !is.finite(C)
    future <- K[, -1, drop = FALSE] > last_k  # cell k+1 lies beyond the observed diagonal
    Ucum <- upper.tri(diag(n_d), diag = TRUE) * 1  # row cumsum as one matrix product
    by_origin <- matrix(0, n, n_o)
    .sc_with_seed(seed, {
      for (s in seq_len(n)) {
        m_star <- m_hat
        m_star[mask] <- m_hat[mask] + res_adj[sample.int(n_obs, n_obs, replace = TRUE)] * sqrt_mhat
        m_star[!is.finite(m_star)] <- 0
        C_star <- m_star %*% Ucum
        C_star[obs_na] <- NA_real_
        f_star <- .sc_factors(C_star, average)$f
        proj <- C_star
        for (k in seq_len(n_d - 1L)) {
          rows <- last_k <= k
          if (any(rows)) proj[rows, k + 1L] <- proj[rows, k] * f_star[k]
        }
        inc <- proj[, -1, drop = FALSE] - proj[, -n_d, drop = FALSE]
        inc[!future] <- 0
        if (process && phi > 0) {
          pos <- future & !is.na(inc) & inc > 0
          if (any(pos)) inc[pos] <- stats::rgamma(sum(pos), shape = inc[pos] / phi, scale = phi)
        }
        by_origin[s, ] <- rowSums(inc)
      }
    })
    totals <- rowSums(by_origin)
    ibnr <- mean(totals)
    se <- if (n > 1) stats::sd(totals) else 0
    q <- stats::quantile(totals, c(0.05, 0.5, 0.75, 0.95, 0.99), names = FALSE, type = 7)
    res_mean <- colMeans(by_origin)
    se_o <- if (n > 1) apply(by_origin, 2, stats::sd) else rep(0, n_o)
    tab <- .sc_res_table(rownames(C), latest, latest + res_mean, list(se = se_o), last_k, cdf_)
    tab$se[nrow(tab)] <- se
    table <- sc_table(tab, title = sprintf("ODP bootstrap · %s simulations", formatC(n, format = "d", big.mark = ",")), stage = "hard",
                      basis = paste0(sprintf("φ = %s", .sc_thousands(phi, 1)), if (process) " · gamma process error" else " · estimation error only"),
                      notes = c(sprintf("Total reserve p5 %s · p50 %s · p75 %s · p95 %s · p99 %s.", .sc_thousands(q[1]), .sc_thousands(q[2]), .sc_thousands(q[3]), .sc_thousands(q[4]), .sc_thousands(q[5])),
                                "Residuals are bias-adjusted Pearson residuals of the incremental ODP fit, resampled with replacement; each pseudo-triangle is refitted by chain ladder and projected with gamma process error."))
    .sc_reserving("bootstrap", table, ibnr, .sc_nansum(latest) + ibnr, .sc_nansum(latest), f, cdf_, se = se, cv = if (ibnr != 0) se / ibnr else NULL,
                  detail = list(totals = totals, phi = phi, p5 = q[1], p50 = q[2], p75 = q[3], p95 = q[4], p99 = q[5], by_origin = by_origin))
  })
}

#' Tail factor from the development pattern
#'
#' Fit ln(f_k − 1) ~ a + b·k (`"exponential"`) or ~ a + b·ln k
#' (`"power"`, inverse power) to the factors above 1 and extrapolate;
#' returns the product of the extrapolated factors over `horizon` further
#' periods.
#' @param factors Link ratios (for example [sc_ldf()] or a result's `factors`).
#' @param method `"exponential"` or `"power"`.
#' @param n_fit Fit the last `n_fit` factors only.
#' @param horizon Periods to extrapolate.
#' @return A single tail factor (1 when no factor exceeds 1).
#' @examples
#' sc_tail(c(1.5, 1.2, 1.1, 1.05, 1.02))
#' @export
sc_tail <- function(factors, method = "exponential", n_fit = NULL, horizon = 50) {
  f <- as.numeric(factors)
  f <- f[is.finite(f) & f > 1]
  if (!length(f)) return(1)
  if (!is.null(n_fit) && n_fit != 0) f <- utils::tail(f, n_fit)
  k <- as.numeric(seq_along(f))
  y <- log(f - 1)
  X <- cbind(1, if (method == "power") log(k) else k)
  beta <- .sc_lstsq(X, y)
  if (horizon < 1) return(1)
  kk <- length(f) + seq_len(horizon)
  Xk <- cbind(1, if (method == "power") log(kk) else kk)
  prod(1 + exp(as.vector(Xk %*% beta)))
}

#' Reserve summary in one line
#'
#' From a claims file (or a triangle) to chain ladder, Mack, Bornhuetter–Ferguson
#' (seeded with the chain-ladder ultimates) and the ODP bootstrap side by
#' side. The individual results are kept in `attr(, "results")`.
#' @param df A long claims data frame or a triangle.
#' @param n_boot Bootstrap simulations.
#' @param seed Seed for the bootstrap.
#' @param ... Passed to [sc_triangle()] (`origin`, `dev`, `value`, `payment`, ...).
#' @return A `scelo_table` with one row per method: method, latest, ultimate,
#'   ibnr, se, cv, p95, p99.
#' @examples
#' sc_reserve(sc_sample("claims"), n_boot = 200)
#' @export
sc_reserve <- function(df, n_boot = 1000, seed = 42, ...) {
  .sc_tool("sc_reserve", Filter(Negate(is.null), list(n_boot = n_boot, seed = seed)), df, {
    tri <- if (.sc_is_triangle(df)) df else sc_triangle(df, ...)
    cl <- sc_chain_ladder(tri)
    mk <- sc_mack(tri)
    b <- sc_bf(tri, apriori = cl)
    bs <- sc_bootstrap(tri, n = n_boot, seed = seed)
    out <- data.frame(method = c(cl$method, mk$method, b$method, bs$method),
                      latest = c(cl$latest, mk$latest, b$latest, bs$latest),
                      ultimate = c(cl$ultimate, mk$ultimate, b$ultimate, bs$ultimate),
                      ibnr = c(cl$ibnr, mk$ibnr, b$ibnr, bs$ibnr),
                      se = c(NA_real_, mk$se, NA_real_, bs$se),
                      cv = c(NA_real_, mk$cv %||% NA_real_, NA_real_, bs$cv %||% NA_real_),
                      p95 = c(NA_real_, NA_real_, NA_real_, bs$detail$p95),
                      p99 = c(NA_real_, NA_real_, NA_real_, bs$detail$p99), stringsAsFactors = FALSE)
    t <- sc_table(out, title = "Reserve summary", basis = if (inherits(tri, "scelo_table")) attr(tri, "basis") else NULL, stage = "hard",
                  notes = c(sprintf("Triangle: %d origins × %d lags. Mack SE ±1.96 → [%s, %s]; bootstrap p95 %s.", nrow(tri), ncol(tri),
                                    .sc_thousands(mk$ibnr - 1.96 * mk$se), .sc_thousands(mk$ibnr + 1.96 * mk$se), .sc_thousands(bs$detail$p95)),
                            "Chain ladder and Mack share the point estimate; BF is seeded with the chain-ladder ultimates; the bootstrap is ODP with gamma process error."))
    attr(t, "results") <- list(chain_ladder = cl, mack = mk, bf = b, bootstrap = bs, triangle = tri)
    t
  })
}
