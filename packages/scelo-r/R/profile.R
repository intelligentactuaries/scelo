# Profiling: the column summary and the descriptive report, one definition.
#
# sc_profile(df) is the IDE's column-summary header (type, missing, unique,
# five-number summary, Tukey fences, outlier count, quintiles, top values,
# date range). sc_describe(df) is the descriptive report every Scelo surface
# prints: Bessel sd, type-7 quantiles, adjusted Fisher-Pearson G1 / G2 shape,
# Jarque-Bera normality, ranked by coefficient of variation. Both follow
# packages/scelo-core exactly, so a median printed here is the median the
# IDE prints for the same file.

.SC_DATE_SHAPE_RE <- "^([0-9]{4})[-/]([0-9]{2})[-/]([0-9]{2})([T ][^ ].*)?$"

.sc_is_missing <- function(v) is.na(v) | (is.character(v) & !is.na(v) & v == "")

.sc_num_or_na <- function(v) {
  # a cell as a number when it is one, or a strictly numeric string (as the IDE types it at import), else NA
  if (is.numeric(v)) return(v)
  if (is.logical(v)) return(rep(NA_real_, length(v)))
  s <- trimws(as.character(v))
  ok <- !is.na(s) & grepl(.SC_NUMERIC_STRING_RE, s) & !grepl("^[+-]?0[0-9]", s)
  out <- rep(NA_real_, length(s))
  out[ok] <- suppressWarnings(as.numeric(s[ok]))
  out[!is.finite(out)] <- NA_real_
  out
}

.sc_date_year <- function(s) {
  m <- regmatches(s, regexec(.SC_DATE_SHAPE_RE, s))
  vapply(m, function(g) {
    if (length(g) < 4) return(NA_integer_)
    mo <- as.integer(g[3]); d <- as.integer(g[4])
    if (is.na(mo) || mo < 1 || mo > 12 || is.na(d) || d < 1 || d > 31) NA_integer_ else as.integer(g[2])
  }, integer(1))
}

#' Scelo's type of a column
#'
#' `number` / `date` / `string` / `bool` under the IDE's rules: a column is
#' numeric when at least 80 % of its non-missing cells are numbers (or
#' strictly numeric strings), a date when at least 80 % of a probe of up to
#' 200 string cells (and at least 8) are unambiguous ISO dates.
#' @param col A vector.
#' @return A string.
#' @export
sc_column_type <- function(col) {
  if (is.logical(col)) return("bool")
  if (is.numeric(col)) return("number")
  if (inherits(col, c("Date", "POSIXt"))) return("date")
  vals <- col[!.sc_is_missing(col)]
  if (!length(vals)) return("string")
  nums <- .sc_num_or_na(vals)
  if (sum(!is.na(nums)) / length(vals) >= 0.8) return("number")
  strs <- as.character(vals[is.character(vals) | is.factor(vals)])
  if (length(strs)) {
    stride <- max(1L, length(strs) %/% 200L)
    probe <- utils::head(strs[seq(1, length(strs), by = stride)], 200)
    if (length(probe) >= 8 && sum(!is.na(.sc_date_year(probe))) / length(probe) >= 0.8) return("date")
  }
  "string"
}

#' Type-7 quantile
#'
#' The R default and numpy default: linear interpolation on (n-1)*q; here
#' on the finite values only.
#' @param x Numbers.
#' @param q Probabilities.
#' @return Quantiles.
#' @export
sc_quantile <- function(x, q) {
  x <- as.numeric(x)
  x <- x[is.finite(x)]
  if (!length(x)) return(rep(0, length(q)))
  unname(stats::quantile(x, q, type = 7, names = FALSE))
}

#' Tukey box statistics
#'
#' Whiskers `lo q1 median q3 hi`, fences and the outliers outside them. With
#' IQR = 0 (at least half the values identical) no outlier classification is
#' made and the whiskers span the range.
#' @param x Numbers.
#' @return A list, or `NULL` when empty.
#' @export
sc_box <- function(x) {
  x <- sort(as.numeric(x)[is.finite(as.numeric(x))])
  if (!length(x)) return(NULL)
  qs <- sc_quantile(x, c(0.25, 0.5, 0.75))
  iqr <- qs[3] - qs[1]
  if (iqr == 0) return(list(lo = x[1], q1 = qs[1], median = qs[2], q3 = qs[3], hi = x[length(x)], lo_fence = qs[1], hi_fence = qs[3], iqr = 0, outliers = numeric()))
  lo_f <- qs[1] - 1.5 * iqr
  hi_f <- qs[3] + 1.5 * iqr
  inside <- x[x >= lo_f & x <= hi_f]
  list(lo = if (length(inside)) inside[1] else x[1], q1 = qs[1], median = qs[2], q3 = qs[3], hi = if (length(inside)) inside[length(inside)] else x[length(x)],
       lo_fence = lo_f, hi_fence = hi_f, iqr = iqr, outliers = x[x < lo_f | x > hi_f])
}

#' Tukey fences
#' @param x Numbers.
#' @param k Multiplier (1.5).
#' @return `c(lo, hi)`.
#' @export
sc_fences <- function(x, k = 1.5) {
  qs <- sc_quantile(x, c(0.25, 0.75))
  c(qs[1] - k * (qs[2] - qs[1]), qs[2] + k * (qs[2] - qs[1]))
}

#' Interquartile range (type 7)
#' @param x Numbers.
#' @export
sc_iqr <- function(x) { qs <- sc_quantile(x, c(0.25, 0.75)); qs[2] - qs[1] }

.sc_moments <- function(x) {
  n <- length(x)
  mean <- mean(x)
  dev <- x - mean
  m2 <- mean(dev^2); m3 <- mean(dev^3); m4 <- mean(dev^4)
  sd <- if (n > 1) sqrt(m2 * n / (n - 1)) else 0
  g1 <- if (m2 > 0) m3 / m2^1.5 else NA_real_
  g2 <- if (m2 > 0) m4 / m2^2 - 3 else NA_real_
  skew <- if (!is.na(g1) && n > 2) sqrt(n * (n - 1)) / (n - 2) * g1 else NA_real_
  kurt <- if (!is.na(g2) && n > 3) (n - 1) / ((n - 2) * (n - 3)) * ((n + 1) * g2 + 6) else NA_real_
  jb <- if (!is.na(g1) && !is.na(g2) && n >= 8) { s <- n / 6 * (g1^2 + g2^2 / 4); c(s, exp(-s / 2)) } else c(NA_real_, NA_real_)
  list(mean = mean, sd = sd, skewness = skew, kurtosis = kurt, jb = jb[1], jb_p = jb[2])
}

#' Shape statistics
#'
#' Adjusted Fisher-Pearson skewness G1, adjusted excess kurtosis G2 (what
#' e1071 type 2, SAS and Excel report) and the Jarque-Bera statistic with
#' its chi-square(2) p-value (on the unadjusted g1 / g2; `NA` below n = 8).
#' @param x Numbers.
#' @return A number (or `c(stat, p)` for [sc_jarque_bera()]).
#' @export
sc_skew <- function(x) .sc_moments(.sc_finite(x))$skewness

#' @rdname sc_skew
#' @export
sc_kurt <- function(x) .sc_moments(.sc_finite(x))$kurtosis

#' @rdname sc_skew
#' @export
sc_jarque_bera <- function(x) { m <- .sc_moments(.sc_finite(x)); c(stat = m$jb, p = m$jb_p) }

.sc_finite <- function(x) { v <- suppressWarnings(as.numeric(x)); v[is.finite(v)] }

.sc_profile_column <- function(col, name) {
  total <- length(col)
  miss <- .sc_is_missing(col)
  present <- col[!miss]
  type <- sc_column_type(col)
  meta <- list(column = name, type = type, count = total, missing = sum(miss), missing_pct = if (total) sum(miss) / total else 0,
               unique = length(unique(as.character(present))), mixed = NA_integer_, min = NA_real_, q1 = NA_real_, median = NA_real_, mean = NA_real_,
               q3 = NA_real_, max = NA_real_, lo_fence = NA_real_, hi_fence = NA_real_, outliers = NA_integer_, top_values = NA_character_,
               date_min = NA_character_, date_max = NA_character_)
  if (type == "number") {
    nums <- if (is.numeric(present)) present else .sc_num_or_na(present)
    mixed <- sum(is.na(nums))
    arr <- nums[is.finite(nums)]
    if (mixed > 0) meta$mixed <- mixed
    if (length(arr)) {
      b <- sc_box(arr)
      meta$min <- min(arr); meta$max <- max(arr); meta$mean <- mean(arr)
      meta$q1 <- b$q1; meta$median <- b$median; meta$q3 <- b$q3; meta$lo_fence <- b$lo_fence; meta$hi_fence <- b$hi_fence; meta$outliers <- length(b$outliers)
    }
  } else if (type == "date") {
    s <- if (inherits(present, "Date")) format(present) else as.character(present)
    ok <- s[!is.na(.sc_date_year(s))]
    if (length(ok)) { meta$date_min <- min(ok); meta$date_max <- max(ok) }
  } else {
    tv <- sort(table(as.character(present)), decreasing = TRUE)
    tv <- utils::head(tv, 8)
    meta$top_values <- paste(sprintf("%s (%d)", names(tv), as.integer(tv)), collapse = ", ")
  }
  meta
}

#' Per-column summary
#'
#' Type, count, missing, unique, min / q1 / median / mean / q3 / max, Tukey
#' fences, outlier count, top values, date range: the numbers the IDE's
#' column headers show. `mixed` counts non-numeric cells in a number-typed
#' column ("6+"), which every numeric stat excludes.
#' @param df A data frame.
#' @param columns Columns to profile (all by default).
#' @return A `scelo_table`, one row per column.
#' @examples
#' sc_profile(sc_sample("claims"))
#' @export
sc_profile <- function(df, columns = NULL) {
  .sc_tool("sc_profile", list(df = df), df, {
    cols <- columns %||% names(df)
    metas <- lapply(cols, function(c) .sc_profile_column(df[[c]], c))
    out <- do.call(rbind, lapply(metas, function(m) as.data.frame(m, stringsAsFactors = FALSE)))
    notes <- character()
    nmiss <- sum(out$missing)
    if (nmiss) notes <- c(notes, sprintf("%s missing cells across %d columns (null or empty string).", format(nmiss, big.mark = ","), sum(out$missing > 0)))
    mixed <- out$column[!is.na(out$mixed)]
    if (length(mixed)) notes <- c(notes, sprintf("Non-numeric residue in number-typed columns (%s): excluded from every numeric stat; see sc_clean.", paste(mixed, collapse = ", ")))
    sc_table(out, title = sprintf("profile · %s rows × %d columns", format(nrow(df), big.mark = ","), length(cols)), notes = notes)
  })
}

#' Descriptive statistics, ranked by coefficient of variation
#'
#' For every numeric column: n, missing, mean, sd (Bessel), se, cv, min, q1,
#' median, q3, max, iqr, skewness (G1), kurtosis (G2), Jarque-Bera and its
#' p-value. Columns whose mean is about 0 (CV undefined) rank last, by sd.
#' @param df A data frame.
#' @param columns Columns (all numeric by default).
#' @param top Keep the first `top` rows.
#' @return A `scelo_table`.
#' @examples
#' sc_describe(sc_sample("claims"))
#' @export
sc_describe <- function(df, columns = NULL, top = NULL) {
  .sc_tool("sc_describe", list(df = df), df, {
    cols <- columns %||% names(df)
    total <- nrow(df)
    rows <- list()
    for (c in cols) {
      s <- df[[c]]
      if (is.logical(s) || inherits(s, c("Date", "POSIXt"))) next
      v <- if (is.numeric(s)) s else .sc_num_or_na(s)
      arr <- sort(v[is.finite(v)])
      n <- length(arr)
      if (!n) next
      m <- .sc_moments(arr)
      qs <- sc_quantile(arr, c(0.25, 0.5, 0.75))
      cv <- if (abs(m$mean) > 1e-12) m$sd / abs(m$mean) else NA_real_
      rows[[length(rows) + 1]] <- data.frame(column = c, n = n, missing = total - n, missing_pct = if (total) (total - n) / total else 0, mean = m$mean, sd = m$sd,
                                             se = m$sd / sqrt(n), cv = cv, min = arr[1], q1 = qs[1], median = qs[2], q3 = qs[3], max = arr[n], iqr = qs[3] - qs[1],
                                             skewness = m$skewness, kurtosis = m$kurtosis, jarque_bera = m$jb, jb_p = m$jb_p, stringsAsFactors = FALSE)
    }
    if (!length(rows)) stop("No numeric columns found: nothing to summarise.", call. = FALSE)
    out <- do.call(rbind, rows)
    out <- out[order(is.na(out$cv), -ifelse(is.na(out$cv), 0, out$cv), -out$sd), ]
    rownames(out) <- NULL
    if (!is.null(top)) out <- utils::head(out, top)
    lead <- out[1, ]
    notes <- c(sprintf("%d numeric columns profiled: sample moments (Bessel), type-7 quantiles, G1/G2 shape, Jarque-Bera normality.", nrow(out)),
               sprintf("Widest relative spread is `%s`%s: mean %.4g, sd %.4g, range [%.4g, %.4g].", lead$column, if (!is.na(lead$cv)) sprintf(" (CV %.2f)", lead$cv) else "", lead$mean, lead$sd, lead$min, lead$max))
    gappy <- sum(out$missing_pct > 0.1)
    if (gappy) notes <- c(notes, sprintf("%d column(s) are >10%% missing/non-numeric: worth resolving before any fit.", gappy))
    sc_table(out, title = sprintf("describe · %s rows", format(total, big.mark = ",")), notes = notes)
  })
}

#' Scelo types of every column
#' @param df A data frame.
#' @return A named character vector.
#' @export
sc_types <- function(df) vapply(df, sc_column_type, character(1))

#' Missing cells per column, worst first
#' @param df A data frame.
#' @return A data frame of `missing` and `pct`.
#' @export
sc_missing <- function(df) {
  m <- vapply(df, function(s) sum(.sc_is_missing(s)), numeric(1))
  out <- data.frame(column = names(df), missing = m, pct = if (nrow(df)) m / nrow(df) else 0, stringsAsFactors = FALSE)
  out <- out[order(-out$missing), ]
  rownames(out) <- NULL
  out
}

#' One- or two-way frequency table (Stata's tab)
#'
#' @param df A data frame.
#' @param col Column.
#' @param by Optional second column.
#' @param pct Row percentages for the two-way table.
#' @return A data frame (one-way) or a table (two-way, with margins).
#' @examples
#' sc_tab(sc_sample("claims"), "line")
#' @export
sc_tab <- function(df, col, by = NULL, pct = FALSE) {
  if (is.null(by)) {
    t <- table(df[[col]], useNA = "ifany")
    t <- sort(t, decreasing = TRUE)
    out <- data.frame(value = names(t), count = as.integer(t), pct = 100 * as.integer(t) / sum(t), stringsAsFactors = FALSE)
    names(out)[1] <- col
    return(out)
  }
  ct <- table(df[[col]], df[[by]])
  if (pct) return(100 * prop.table(ct, 1))
  stats::addmargins(ct)
}

#' Correlation matrix of the numeric columns
#' @param df A data frame.
#' @param method pearson / spearman / kendall.
#' @param min_abs Blank cells weaker than this.
#' @export
sc_corr <- function(df, method = "pearson", min_abs = 0) {
  c <- stats::cor(df[.sc_numeric_columns(df)], method = method, use = "pairwise.complete.obs")
  if (min_abs > 0) c[abs(c) < min_abs] <- NA
  c
}

#' Rows outside / inside the Tukey fences of a column
#' @param df A data frame.
#' @param col Column.
#' @param k Fence multiplier.
#' @return A data frame.
#' @export
sc_outliers <- function(df, col, k = 1.5) {
  f <- sc_fences(df[[col]], k)
  v <- suppressWarnings(as.numeric(df[[col]]))
  df[!is.na(v) & (v < f[1] | v > f[2]), , drop = FALSE]
}

#' @rdname sc_outliers
#' @export
sc_inliers <- function(df, col, k = 1.5) {
  f <- sc_fences(df[[col]], k)
  v <- suppressWarnings(as.numeric(df[[col]]))
  df[!(!is.na(v) & (v < f[1] | v > f[2])), , drop = FALSE]
}
