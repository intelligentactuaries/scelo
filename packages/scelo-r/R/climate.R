# Climate: reanalysis ensembles, return periods, parametric triggers.
#
# The IDE's climate family works on multi-reanalysis daily series (ERA5 /
# MERRA-2 / JRA-3Q, the bundled "climate" sample) and on loss files. These
# are the deterministic pieces, kept separate from any fitted model so the
# numbers an underwriter quotes (a 1-in-100 loss, a trigger level, an AAL)
# come with their method in the basis: ensemble agreement across members,
# empirical and Gumbel return periods, a parametric trigger at a loss
# quantile, the AAL of an event set and seasonal anomalies. Follows
# packages/scelo-py/src/scelo/climate.py.

.SC_REANALYSIS_RE <- "(era5|merra[-_]?2|jra[-_]?3?q?|ncep|cfsr|nora)"

#' Reanalysis ensemble summary
#'
#' Per-date ensemble mean, spread (sd) and range across reanalysis members:
#' the numeric columns whose names mention a reanalysis (era5, merra2,
#' jra3q, ncep, cfsr, nora), filtered by a `variable` prefix, or the
#' `members` given.
#'
#' @param df A data frame (one row per date).
#' @param variable Column-name prefix selecting one variable ("t2m").
#' @param members Member columns, when not inferred.
#' @param date Date column (inferred by alias; optional).
#' @return A `scelo_table` of the date, `mean`, `spread`, `min`, `max`.
#' @examples
#' sc_ensemble(sc_sample("climate"), "t2m")
#' @export
sc_ensemble <- function(df, variable = NULL, members = NULL, date = NULL) {
  .sc_tool("sc_ensemble", list(df = df, variable = variable, members = members, date = date), df, {
    d <- sc_infer(df, "date", date, required = FALSE)
    if (is.null(members)) {
      cands <- .sc_numeric_columns(df)
      cands <- cands[grepl(.SC_REANALYSIS_RE, cands, ignore.case = TRUE)]
      if (!is.null(variable)) cands <- cands[startsWith(tolower(cands), tolower(variable))]
      if (!length(cands)) stop("no reanalysis member columns found (era5 / merra2 / jra3q …); pass members = c(…)", call. = FALSE)
      members <- cands
    }
    members <- as.character(members)
    M <- do.call(cbind, lapply(df[members], .sc_num_or_na))
    if (is.null(dim(M))) M <- matrix(M, ncol = length(members))
    k <- rowSums(!is.na(M))
    mean <- rowMeans(M, na.rm = TRUE)
    mean[k == 0] <- NA_real_
    spread <- sqrt(rowSums((M - mean)^2, na.rm = TRUE) / (k - 1))
    spread[k < 2] <- NA_real_
    mn <- do.call(pmin, c(lapply(seq_len(ncol(M)), function(j) M[, j]), list(na.rm = TRUE)))
    mx <- do.call(pmax, c(lapply(seq_len(ncol(M)), function(j) M[, j]), list(na.rm = TRUE)))
    mn[k == 0] <- NA_real_
    mx[k == 0] <- NA_real_
    out <- data.frame(mean = mean, spread = spread, min = mn, max = mx)
    if (!is.null(d)) out <- cbind(stats::setNames(data.frame(df[[d]], stringsAsFactors = FALSE), d), out)
    cv <- spread / abs(mean)
    cv[!is.na(mean) & mean == 0] <- NA_real_
    agree <- stats::median(cv, na.rm = TRUE)
    sc_table(out, title = sprintf("Ensemble · %d members", length(members)), basis = paste(members, collapse = ", "), stage = "hard", notes = c(
      sprintf("Median member CV %.3f: the reanalyses %s on this variable.", agree, if (is.na(agree)) "cannot be compared" else if (agree < 0.05) "agree closely" else if (agree > 0.2) "disagree materially" else "broadly agree")
    ))
  })
}

# np.interp: linear interpolation on increasing xp, clamped outside the range.
.sc_interp <- function(xout, xp, yp) {
  if (length(xp) < 2) return(rep(yp[1], length(xout)))
  stats::approx(xp, yp, xout = xout, rule = 2, ties = "ordered")$y
}

#' Return-period losses
#'
#' From annual maxima or an event set: empirical (Weibull plotting position
#' (T + 1) / rank with log-linear interpolation, blank beyond the record)
#' and Gumbel (method of moments, only when the losses are one per year).
#'
#' @param losses One value per year (annual maxima / totals), or an event
#'   set with `years` = the length of record.
#' @param years Years of record for an event set (`NULL`: one loss per year).
#' @param periods Return periods to tabulate.
#' @return A `scelo_table` of `return_period`, `empirical`, `gumbel`.
#' @examples
#' set.seed(1)
#' sc_return_period(100 - 30 * log(-log(runif(40))))
#' @export
sc_return_period <- function(losses, years = NULL, periods = c(2, 5, 10, 25, 50, 100, 200, 250, 500)) {
  .sc_tool("sc_return_period", list(losses = losses, years = years, periods = periods), NULL, {
    x <- as.numeric(losses)
    x <- sort(x[!is.na(x)], decreasing = TRUE)
    n <- length(x)
    T <- if (!is.null(years) && years != 0) as.numeric(years) else n
    rp_emp <- (T + 1) / seq_len(n)
    # Gumbel by moments
    m <- mean(x)
    s <- stats::sd(x)
    beta <- s * sqrt(6) / pi
    mu <- m - 0.5772156649 * beta
    emp <- vapply(periods, function(p) if (p <= max(rp_emp)) .sc_interp(log(p), log(rev(rp_emp)), rev(x)) else NA_real_, numeric(1))
    gum <- if (is.null(years)) mu - beta * log(-log(1 - 1 / periods)) else rep(NA_real_, length(periods))
    out <- data.frame(return_period = periods, empirical = emp, gumbel = gum)
    sc_table(out, title = "Return periods", basis = sprintf("%d values over %s years", n, sprintf("%g", T)), stage = "hard", notes = c(
      "Empirical: Weibull plotting position (T+1)/rank with log-linear interpolation, blank beyond the record; Gumbel: method-of-moments fit to annual maxima (only when losses are one-per-year)."
    ))
  })
}

#' Parametric trigger
#'
#' The IDE's parametric design: trigger at the p-quantile of the losses,
#' payout cap = `cap_multiple` times the trigger, and the empirical
#' attachment probability.
#'
#' @param losses Losses.
#' @param p Quantile of the trigger.
#' @param cap_multiple Cap as a multiple of the trigger.
#' @return A list: `trigger`, `cap`, `attachment_probability`.
#' @examples
#' sc_parametric_trigger(1:100)
#' @export
sc_parametric_trigger <- function(losses, p = 0.9, cap_multiple = 4) {
  x <- as.numeric(losses)
  x <- sort(x[!is.na(x)])
  n <- length(x)
  if (!n) stop("no losses", call. = FALSE)
  trig <- x[min(floor(p * n), n - 1) + 1]
  list(trigger = trig, cap = cap_multiple * trig, attachment_probability = mean(x >= trig))
}

#' Average annual loss
#'
#' Sum of f_e * L_e for an event set with annual frequencies, or sum of L
#' over the years of record for a history.
#'
#' @param event_losses Event losses.
#' @param frequencies Annual frequency per event (`NULL` for a history).
#' @param years Years of record (for a history).
#' @return A number.
#' @examples
#' sc_aal(c(10, 20, 30), years = 3)
#' sc_aal(c(1e6, 5e6), frequencies = c(0.1, 0.01))
#' @export
sc_aal <- function(event_losses, frequencies = NULL, years = NULL) {
  L <- as.numeric(event_losses)
  L <- L[!is.na(L)]
  if (!is.null(frequencies)) return(sum(as.numeric(frequencies) * L))
  if (is.null(years)) stop("give frequencies per event or the number of years of record", call. = FALSE)
  sum(L) / years
}

.sc_season_key <- function(dates, by) {
  d <- if (inherits(dates, "Date")) dates else if (inherits(dates, "POSIXt")) as.Date(dates) else as.Date(as.character(dates))
  if (anyNA(d)) stop("dates must be Date / POSIXt values or ISO date strings", call. = FALSE)
  if (by == "month") as.integer(format(d, "%m")) else as.POSIXlt(d)$yday + 1L
}

#' Anomaly versus a seasonal baseline
#'
#' The series minus its monthly (or day-of-year) climatology, taken from
#' `baseline` or from the series itself. `series` is a numeric vector with
#' dates as names (or `dates` given), or a data frame with a date column
#' (inferred by alias) and one numeric column.
#'
#' @param series Values: a named numeric vector, or a data frame.
#' @param dates Dates of `series` when it is not named.
#' @param baseline Baseline values (same forms as `series`); `NULL` uses the series.
#' @param baseline_dates Dates of `baseline` when it is not named.
#' @param by "month" or "day" (day of year).
#' @return A numeric vector named by date.
#' @examples
#' cl <- sc_sample("climate")
#' head(sc_anomaly(stats::setNames(cl$t2m_era5, cl$date)))
#' @export
sc_anomaly <- function(series, dates = NULL, baseline = NULL, baseline_dates = NULL, by = "month") {
  unpack <- function(v, dts) {
    if (is.data.frame(v)) {
      dc <- sc_infer(v, "date", NULL)
      vc <- setdiff(.sc_numeric_columns(v), dc)
      if (!length(vc)) stop("the data frame needs one numeric column next to its date column", call. = FALSE)
      return(list(x = as.numeric(v[[vc[1]]]), d = v[[dc]]))
    }
    d <- dts %||% names(v)
    if (is.null(d)) stop("series needs dates: pass a named vector, a data frame with a date column, or dates = <dates>", call. = FALSE)
    list(x = as.numeric(v), d = d)
  }
  s <- unpack(series, dates)
  b <- if (is.null(baseline)) s else unpack(baseline, baseline_dates)
  key <- .sc_season_key(s$d, by)
  bkey <- .sc_season_key(b$d, by)
  clim <- tapply(b$x, bkey, mean, na.rm = TRUE)
  out <- s$x - as.numeric(clim[as.character(key)])
  names(out) <- as.character(s$d)
  out
}
