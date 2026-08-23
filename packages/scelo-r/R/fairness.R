# Fairness: group metrics and the IDE's protected-direction audit.
#
# A rating model can discriminate without ever seeing the protected
# attribute, so two readouts live here. sc_fairness() gives the standard
# group metrics (demographic parity, disparate impact / four-fifths, equal
# opportunity, equalised odds, calibration by group) for a score or a
# decision. sc_fairness_audit() is the Hard Data layer's indirect-
# discrimination readout (workspace/fairness.ts): residualise a prediction
# on the legitimate factors, measure how much of what is left aligns with
# the protected attribute, and show the same numbers after mitigation, so
# the before / after sits in one table. Both follow
# packages/scelo-py/src/scelo/fairness.py.

.sc_binary <- function(s) {
  if (is.logical(s)) return(as.numeric(s))
  v <- .sc_num_or_na(s)
  if (!anyNA(v)) return(v)
  as.numeric(tolower(trimws(as.character(s))) %in% c("1", "true", "yes", "y", "t"))
}

.sc_nanmax <- function(v) if (all(is.na(v))) NA_real_ else max(v, na.rm = TRUE)
.sc_nanmin <- function(v) if (all(is.na(v))) NA_real_ else min(v, na.rm = TRUE)

#' Group fairness metrics
#'
#' Per level of `group`: n, base rate, selection rate, disparate impact,
#' TPR / FPR, precision (calibration of the positive decision) and the mean
#' score, with the parity gaps in the notes. `pred` may be a probability /
#' score (thresholded at `threshold`) or a 0/1 decision; `y` a 0/1 outcome.
#' Disparate impact is each group's selection rate over the best-off
#' group's (the four-fifths rule flags < 0.8).
#'
#' @param df A data frame.
#' @param y Outcome column (0/1, logical, or yes / true strings).
#' @param pred Score or decision column.
#' @param group Protected-group column.
#' @param threshold Decision threshold for a score.
#' @return A `scelo_table`, one row per group.
#' @examples
#' df <- data.frame(g = rep(c("a", "b"), 50), y = rep(c(0, 1, 1, 0), 25),
#'                  score = rep(c(0.7, 0.4, 0.8, 0.3), 25))
#' sc_fairness(df, "y", "score", "g")
#' @export
sc_fairness <- function(df, y, pred, group, threshold = 0.5) {
  .sc_tool("sc_fairness", list(df = df, y = y, pred = pred, group = group, threshold = threshold), df, {
    yy <- .sc_binary(df[[y]])
    pp <- .sc_num_or_na(df[[pred]])
    score_like <- (!all(is.na(pp)) && max(pp, na.rm = TRUE) > 1) || any(pp > 0 & pp < 1, na.rm = TRUE)
    dec <- if (score_like) as.numeric(!is.na(pp) & pp >= threshold) else pp
    g <- as.character(df[[group]])
    lvls <- unique(g)
    rows <- lapply(lvls, function(lv) {
      m <- if (is.na(lv)) is.na(g) else !is.na(g) & g == lv
      d <- dec[m]
      pos <- yy[m] == 1
      neg <- yy[m] == 0
      data.frame(group = lv, n = sum(m), base_rate = mean(yy[m]), selection_rate = mean(d),
                 tpr = if (any(pos, na.rm = TRUE)) mean(d[which(pos)]) else NA_real_,
                 fpr = if (any(neg, na.rm = TRUE)) mean(d[which(neg)]) else NA_real_,
                 precision = if (any(d == 1, na.rm = TRUE)) mean(yy[m][which(d == 1)]) else NA_real_,
                 mean_score = mean(pp[m], na.rm = TRUE), stringsAsFactors = FALSE)
    })
    out <- do.call(rbind, rows)
    names(out)[1] <- group
    out$disparate_impact <- out$selection_rate / .sc_nanmax(out$selection_rate)
    di_min <- .sc_nanmin(out$disparate_impact)
    notes <- c(
      paste0(sprintf("Demographic parity gap %.3f; disparate impact min %.3f", .sc_nanmax(out$selection_rate) - .sc_nanmin(out$selection_rate), di_min),
             if (!is.na(di_min) && di_min < 0.8) " (below the four-fifths rule)" else " (passes the four-fifths rule)", "."),
      sprintf("Equal-opportunity gap (TPR) %.3f; equalised-odds FPR gap %.3f.", .sc_nanmax(out$tpr) - .sc_nanmin(out$tpr), .sc_nanmax(out$fpr) - .sc_nanmin(out$fpr))
    )
    sc_table(out, title = sprintf("Fairness · %s vs %s by %s", pred, y, group), basis = sprintf("threshold %s", format(threshold)), stage = "hard", notes = notes)
  })
}

#' Disparate impact
#'
#' Selection rate of each group relative to the best-off group (a score is
#' thresholded at `threshold` when it has values strictly between 0 and 1).
#' `sc_parity()` is an alias.
#'
#' @inheritParams sc_fairness
#' @return A named numeric vector, one entry per group (sorted), max = 1.
#' @examples
#' df <- data.frame(g = rep(c("a", "b"), 50), score = rep(c(0.7, 0.4, 0.8, 0.3), 25))
#' sc_disparate_impact(df, "score", "g")
#' @export
sc_disparate_impact <- function(df, pred, group, threshold = 0.5) {
  pp <- .sc_num_or_na(df[[pred]])
  dec <- if (any(pp > 0 & pp < 1, na.rm = TRUE)) as.numeric(!is.na(pp) & pp >= threshold) else pp
  g <- as.character(df[[group]])
  keep <- !is.na(g)
  lv <- sort(unique(g[keep]), method = "radix")
  s <- as.numeric(rowsum(dec[keep], match(g[keep], lv))) / tabulate(match(g[keep], lv), length(lv))
  names(s) <- lv
  s / max(s, na.rm = TRUE)
}

#' @rdname sc_disparate_impact
#' @export
sc_parity <- sc_disparate_impact

.sc_ols_fit <- function(X, y) {
  Xi <- cbind(1, X)
  as.vector(qr.fitted(qr(Xi), y))
}

#' Protected-direction audit
#'
#' How much of a prediction's variation beyond the legitimate factors aligns
#' with a protected attribute. `pred` is residualised on `legitimate` (OLS);
#' `alignment` = corr(residual, protected)^2 * var(residual) / var(pred);
#' `disparity` = standardised mean gap in `pred` between the protected median
#' split; `fit_to_legitimate` the R-squared of `pred` against its legitimate
#' fit. The `after` row replaces `pred` with its legitimate fit plus the
#' residual orthogonalised to the protected attribute; that mitigated
#' prediction is the `mitigated` attribute of the result (named by the rows
#' used).
#'
#' @param df A data frame.
#' @param pred Prediction column.
#' @param protected Protected-attribute column (numeric or 0/1).
#' @param legitimate Character vector of legitimate rating-factor columns.
#' @return A `scelo_table` with rows `before` and `after`: `stage`,
#'   `alignment`, `disparity`, `fit_to_legitimate`.
#' @examples
#' set.seed(1)
#' df <- data.frame(age = sample(18:69, 400, TRUE), prot = rbinom(400, 1, 0.3))
#' df$score <- 0.02 * df$age + 0.5 * df$prot + rnorm(400, 0, 0.1)
#' sc_fairness_audit(df, "score", "prot", "age")
#' @export
sc_fairness_audit <- function(df, pred, protected, legitimate) {
  .sc_tool("sc_fairness_audit", list(df = df, pred = pred, protected = protected, legitimate = legitimate), df, {
    legitimate <- as.character(legitimate)
    cols <- c(pred, protected, legitimate)
    missing <- setdiff(cols, names(df))
    if (length(missing)) stop(sprintf("column \"%s\" is not in the data (have: %s)", missing[1], paste(names(df), collapse = ", ")), call. = FALSE)
    d <- as.data.frame(lapply(df[cols], .sc_num_or_na), stringsAsFactors = FALSE)
    names(d) <- cols
    d <- d[stats::complete.cases(d), , drop = FALSE]
    if (nrow(d) < 10) stop("need at least 10 complete rows", call. = FALSE)
    p <- d[[pred]]
    A <- d[[protected]]
    L <- as.matrix(d[legitimate])
    fit <- .sc_ols_fit(L, p)
    resid <- p - fit
    pvar <- function(v) mean((v - mean(v))^2)
    psd <- function(v) sqrt(pvar(v))
    alignment <- function(r) if (psd(r) == 0 || psd(A) == 0) 0 else stats::cor(r, A)^2 * pvar(r) / pvar(p)
    disparity <- function(x) {
      hi <- A >= stats::median(A)
      if (all(hi) || !any(hi)) hi <- A > stats::median(A)
      if (all(hi) || !any(hi)) return(0)
      abs(mean(x[hi]) - mean(x[!hi])) / (if (psd(x) != 0) psd(x) else 1)
    }
    r2 <- function(x) if (pvar(fit) != 0) 1 - sum((x - fit)^2) / sum((fit - mean(fit))^2) else 0
    resid_clean <- resid - .sc_ols_fit(matrix(A, ncol = 1), resid) + mean(resid)
    p_after <- fit + resid_clean
    out <- data.frame(stage = c("before", "after"), alignment = c(alignment(resid), alignment(p_after - fit)),
                      disparity = c(disparity(p), disparity(p_after)), fit_to_legitimate = c(r2(p), r2(p_after)), stringsAsFactors = FALSE)
    t <- sc_table(out, title = sprintf("Protected-direction audit · %s vs %s", pred, protected),
                  basis = sprintf("legitimate: %s · n = %s", paste(legitimate, collapse = ", "), format(nrow(d), big.mark = ",")), stage = "hard", notes = c(
                    "alignment = share of the prediction's non-legitimate variation aligned with the protected attribute; disparity = |mean gap| / sd across the protected median split. Mitigation orthogonalises the residual to the protected attribute and keeps the legitimate fit."
                  ))
    attr(t, "mitigated") <- stats::setNames(p_after, rownames(d))
    t
  })
}
