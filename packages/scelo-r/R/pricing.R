# Pricing: GLMs, relativities, frequency / severity, loss ratios, lift.
#
# sc_glm(df, "claims ~ C(region) + age", "poisson", offset = "exposure")
# is the pricing model as actuaries write it: a small formula subset
# (y ~ a + C(b) + c, where C() marks a categorical and numeric terms enter
# linearly), categorical base levels at the most frequent level so every
# relativity reads as "relative to the bulk of the book", an exposure
# offset entering as log(offset). The engine is stats::glm.fit on the same
# design matrix the Python package builds (its numpy IRLS exists only
# because Python lacks a native GLM), so coefficient names, deviances and
# dispersions match packages/scelo-py/src/scelo/pricing.py; the AIC follows
# the Python definitions (Pearson-dispersion gamma likelihood), which for
# the gamma family differs from stats::glm's.

.SC_TERM_RE <- "^C\\((.+)\\)$"

.SC_FAMILY_LINKS <- c(poisson = "log", gamma = "log", gaussian = "identity", binomial = "logit", tweedie = "log", inverse_gaussian = "log")

.sc_formula_text <- function(formula) {
  if (inherits(formula, "formula")) paste(deparse(formula, width.cutoff = 500L), collapse = " ") else as.character(formula)
}

.sc_formula_sides <- function(formula) {
  formula <- .sc_formula_text(formula)
  pos <- regexpr("~", formula, fixed = TRUE)
  if (pos < 0) stop('formula must look like "y ~ x1 + C(x2)"', call. = FALSE)
  list(lhs = trimws(substr(formula, 1, pos - 1)), rhs = trimws(substr(formula, pos + 1, nchar(formula))))
}

#' Design matrix for the Scelo formula subset
#'
#' Parse `y ~ a + C(b) + c` into the response, a design matrix with an
#' `Intercept` column and the term names. `C()` marks a categorical (so do
#' character, factor and logical columns): it is one-hot encoded with the
#' most frequent level dropped as the base, columns named `b[level]`.
#' Numeric terms enter linearly.
#'
#' @param df A data frame.
#' @param formula A string or formula.
#' @param drop_first Drop the base level of each categorical (`TRUE`).
#' @param base Reference level of each categorical: `"frequent"` (the most
#'   common level, Scelo's default), `"first"` (alphabetical, as [stats::glm()]
#'   and statsmodels) or a named list `list(factor = level)`.
#' @param levels Named list of the dummy levels to build per categorical
#'   (used by [sc_predict()] to reproduce the training design).
#' @return A list: `y`, `X` (numeric matrix), `terms`, `levels` (dummy levels
#'   per factor), `base_levels` (the reference level per factor).
#' @examples
#' d <- sc_design_matrix(sc_sample("claims"), "paid ~ C(line) + age")
#' colnames(d$X)
#' @export
sc_design_matrix <- function(df, formula, drop_first = TRUE, levels = NULL, base = "frequent") {
  sides <- .sc_formula_sides(formula)
  terms <- trimws(strsplit(sides$rhs, "+", fixed = TRUE)[[1]])
  terms <- terms[nzchar(terms) & terms != "1"]
  if (!sides$lhs %in% names(df)) stop(sprintf("column '%s' is not in the data", sides$lhs), call. = FALSE)
  y <- .sc_num_or_na(df[[sides$lhs]])
  n <- nrow(df)
  cols <- list(Intercept = rep(1, n))
  names_out <- character()
  cat_levels <- list()
  base_levels <- list()
  for (t in terms) {
    m <- regmatches(t, regexec(.SC_TERM_RE, t))[[1]]
    is_cat <- length(m) > 0
    name <- if (is_cat) trimws(m[2]) else t
    if (!name %in% names(df)) stop(sprintf("column '%s' is not in the data", name), call. = FALSE)
    col <- df[[name]]
    if (is_cat || !is.numeric(col) || is.logical(col)) {
      s <- as.character(col)
      if (!is.null(levels[[name]])) {
        use <- levels[[name]]
        rest <- setdiff(unique(s), use)
        base_levels[[name]] <- if (length(rest)) rest[1] else ""
      } else {
        cnt <- table(s)
        if (is.list(base) && !is.null(base[[name]])) {
          ref <- as.character(base[[name]])
          if (!ref %in% names(cnt)) stop(sprintf("base level '%s' is not a level of '%s'", ref, name), call. = FALSE)
          lv <- c(ref, sort(setdiff(names(cnt), ref), method = "radix"))
        } else if (identical(base, "first")) {
          lv <- sort(names(cnt), method = "radix")
        } else {
          lv <- names(cnt)[order(-as.integer(cnt), names(cnt), method = "radix")]   # most common level first = base
        }
        use <- if (drop_first) lv[-1] else lv
        base_levels[[name]] <- lv[1]
      }
      for (l in use) cols[[sprintf("%s[%s]", name, l)]] <- as.numeric(s == l)
      cat_levels[[name]] <- use
    } else {
      cols[[name]] <- .sc_num_or_na(col)
    }
    names_out <- c(names_out, name)
  }
  X <- do.call(cbind, cols)
  colnames(X) <- names(cols)
  list(y = y, X = X, terms = names_out, levels = cat_levels, base_levels = base_levels)
}

.sc_family_object <- function(family, link, power) {
  switch(family,
    poisson = stats::poisson(link = link),
    gamma = stats::Gamma(link = link),
    gaussian = stats::gaussian(link = link),
    binomial = stats::binomial(link = link),
    inverse_gaussian = stats::inverse.gaussian(link = link),
    tweedie = {
      .sc_need("statmod", "for the tweedie family")
      link_power <- switch(link, log = 0, identity = 1, stop(sprintf("unsupported link %s for tweedie", link), call. = FALSE))
      statmod::tweedie(var.power = power, link.power = link_power)
    }
  )
}

#' Fit a pricing GLM
#'
#' `sc_glm(df, "claims ~ C(region) + age", "poisson", offset = "exposure")`.
#' Families: poisson, gamma, gaussian, binomial, tweedie (`power`),
#' inverse_gaussian; default links log / log / identity / logit / log / log.
#' `offset` is a column entering as log(offset) (exposure); `weights` prior
#' weights. Rows with a missing response or term, a non-positive offset (or,
#' for gamma / inverse_gaussian, a non-positive response) are dropped.
#'
#' @param df A data frame.
#' @param formula `y ~ a + C(b) + c` (string or formula): `C()` marks a
#'   categorical whose base level is its most frequent level.
#' @param family poisson / gamma / gaussian / binomial / tweedie / inverse_gaussian.
#' @param offset Exposure column (enters as log(offset)).
#' @param weights Prior-weight column.
#' @param link Link override: log / identity / logit.
#' @param power Tweedie variance power (needs the statmod package).
#' @param base Reference level of each categorical: `"frequent"` (most common,
#'   the default), `"first"` (alphabetical, as [stats::glm()]) or a named list.
#' @return A `scelo_glm`: `family`, `link`, `formula`, `coef` (a
#'   `scelo_table` of term / estimate / std_err / z / p_value / exp),
#'   `params`, `cov`, `deviance`, `null_deviance`, `aic`, `n`, `df_resid`,
#'   `dispersion`, `fitted`, `engine`, `terms`, `levels`.
#' @examples
#' claims <- sc_sample("claims")
#' m <- sc_glm(claims, "paid ~ C(line) + age", "gamma")
#' m
#' sc_relativities(m)
#' @export
sc_glm <- function(df, formula, family = "poisson", offset = NULL, weights = NULL, link = NULL, power = 1.5, base = "frequent") {
  formula <- .sc_formula_text(formula)
  .sc_tool("sc_glm", list(df = df, formula = formula, family = family, offset = offset, weights = weights, link = link, power = power), df, {
    family <- tolower(family)
    if (!family %in% names(.SC_FAMILY_LINKS)) stop(sprintf("family must be one of %s", paste(names(.SC_FAMILY_LINKS), collapse = ", ")), call. = FALSE)
    link <- link %||% .SC_FAMILY_LINKS[[family]]
    d <- sc_design_matrix(df, formula, base = base)
    y <- d$y
    X <- d$X
    keep <- !is.na(y) & stats::complete.cases(X)
    off_vals <- NULL
    if (!is.null(offset)) {
      off_vals <- .sc_num_or_na(df[[offset]])
      keep <- keep & !is.na(off_vals) & off_vals > 0
    }
    w_vals <- NULL
    if (!is.null(weights)) {
      w_vals <- .sc_num_or_na(df[[weights]])
      keep <- keep & !is.na(w_vals)
    }
    if (family %in% c("gamma", "inverse_gaussian")) keep <- keep & !is.na(y) & y > 0
    keep[is.na(keep)] <- FALSE
    y_ <- y[keep]
    X_ <- X[keep, , drop = FALSE]
    n <- sum(keep)
    p <- ncol(X_)
    if (n < p + 1) stop(sprintf("only %d usable rows for %d parameters", n, p), call. = FALSE)
    off <- if (!is.null(offset)) log(off_vals[keep]) else rep(0, n)
    wts <- if (!is.null(weights)) w_vals[keep] else rep(1, n)
    fam <- .sc_family_object(family, link, power)
    fit <- suppressWarnings(stats::glm.fit(X_, y_, weights = wts, offset = off, family = fam, intercept = TRUE,
                                           control = stats::glm.control(epsilon = 1e-12, maxit = 100)))
    beta <- fit$coefficients
    mu <- fit$fitted.values
    dev <- fit$deviance
    df_resid <- fit$df.residual
    # null deviance at the intercept-only fit: with a log link the offset is kept (mu0 = exp(offset) * sum(w y) / sum(w exp(offset)))
    mu0 <- rep(sum(wts * y_) / sum(wts), n)
    if (family != "tweedie" && !is.null(offset) && link == "log") mu0 <- exp(off + log(sum(wts * y_) / sum(wts * exp(off))))
    null_dev <- sum(fam$dev.resids(y_, mu0, wts))
    # unscaled covariance as summary.glm computes it, then scaled by the Pearson dispersion
    Qr <- fit$qr
    p1 <- seq_len(fit$rank)
    cov_u <- matrix(NA_real_, p, p, dimnames = list(colnames(X_), colnames(X_)))
    piv <- Qr$pivot[p1]
    cov_u[piv, piv] <- chol2inv(Qr$qr[p1, p1, drop = FALSE])
    pearson <- sum(wts * (y_ - mu)^2 / fam$variance(mu))
    disp <- if (family %in% c("poisson", "binomial")) 1 else pearson / df_resid
    cov <- cov_u * disp
    se <- sqrt(diag(cov))
    aic <- switch(family,
      poisson = { ll <- sum(wts * (y_ * log(mu) - mu - lgamma(y_ + 1))); 2 * p - 2 * ll },
      gaussian = { s2 <- dev / n; ll <- -n / 2 * (log(2 * pi * s2) + 1); 2 * (p + 1) - 2 * ll },
      binomial = { ll <- sum(wts * (y_ * log(mu) + (1 - y_) * log(1 - mu))); 2 * p - 2 * ll },
      gamma = { a <- 1 / disp; ll <- sum(wts * (a * log(a * y_ / mu) - a * y_ / mu - log(y_) - lgamma(a))); 2 * (p + 1) - 2 * ll },
      NA_real_
    )
    eng <- "stats::glm"
    z <- beta / ifelse(!is.na(se) & se > 0, se, NA_real_)
    pval <- 2 * (1 - stats::pnorm(abs(z)))
    coef <- data.frame(term = names(beta), estimate = unname(beta), std_err = unname(se), z = unname(z), p_value = unname(pval), stringsAsFactors = FALSE)
    if (link == "log") coef$exp <- exp(coef$estimate)
    t <- sc_table(coef, title = sprintf("GLM · %s · %s", family, formula),
                  basis = paste0(sprintf("%s / %s · %s", family, link, eng), if (!is.null(offset)) sprintf(" · offset log(%s)", offset) else ""),
                  stage = "hard", notes = c(
                    paste0(sprintf("n = %s, deviance %s on %d df (null %s), dispersion %.4g", format(n, big.mark = ","), .sc_fmt_comma(dev), df_resid, .sc_fmt_comma(null_dev), disp),
                           if (!is.na(aic)) sprintf(", AIC %s", .sc_fmt_comma(aic, 1)) else "", "."),
                    paste0(if (identical(base, "frequent")) "Categorical base levels are the most frequent level" else if (identical(base, "first")) "Categorical base levels are the alphabetically first level" else "Categorical base levels as given", "; with a log link, exp(estimate) is the multiplicative relativity.")
                  ))
    structure(list(family = family, link = link, formula = formula, coef = t, params = beta, cov = cov, deviance = dev, null_deviance = null_dev,
                   aic = aic, n = n, df_resid = df_resid, dispersion = disp, fitted = unname(mu), engine = eng, offset_col = offset,
                   weights_col = weights, terms = d$terms, power = if (family == "tweedie") power else NULL, levels = d$levels, iterations = fit$iter, base = base, base_levels = d$base_levels),
              class = c("scelo_glm", "list"))
  })
}

#' @export
print.scelo_glm <- function(x, ...) {
  cat(sprintf("GLM %s (%s) · %s · n = %s · deviance %s (null %s) · dispersion %.4g", x$family, x$link, x$formula, format(x$n, big.mark = ","),
              .sc_fmt_comma(x$deviance), .sc_fmt_comma(x$null_deviance), x$dispersion),
      if (!is.null(x$aic) && !is.na(x$aic)) sprintf(" · AIC %s", .sc_fmt_comma(x$aic, 1)) else "", sprintf(" · %s", x$engine), "\n", sep = "")
  print(x$coef, ...)
  invisible(x)
}

#' @export
summary.scelo_glm <- function(object, ...) object$coef

#' Predict from a Scelo GLM
#'
#' Predicted means for new data. The offset is the model's offset column by
#' default; pass another column name or a vector of exposures.
#'
#' @param model A `scelo_glm` from [sc_glm()].
#' @param df New data (the response column need not be present).
#' @param offset Offset column name, or a numeric vector of exposures.
#' @return A numeric vector of predicted means.
#' @examples
#' claims <- sc_sample("claims")
#' m <- sc_glm(claims, "paid ~ C(line) + age", "gamma")
#' head(sc_predict(m, claims))
#' @export
sc_predict <- function(model, df, offset = NULL) {
  lhs <- .sc_formula_sides(model$formula)$lhs
  df2 <- df
  df2[[lhs]] <- 0
  d <- sc_design_matrix(df2, model$formula, levels = model$levels)
  params <- model$params
  params[is.na(params)] <- 0
  X <- matrix(0, nrow(df), length(params), dimnames = list(NULL, names(params)))
  common <- intersect(colnames(d$X), names(params))
  X[, common] <- d$X[, common, drop = FALSE]
  eta <- as.vector(X %*% params)
  off <- offset %||% model$offset_col
  if (!is.null(off)) {
    vals <- if (is.character(off) && length(off) == 1) .sc_num_or_na(df[[off]]) else as.numeric(off)
    eta <- eta + log(pmax(vals, 1e-12))
  }
  switch(model$link, log = exp(eta), identity = eta, logit = 1 / (1 + exp(-eta)), stop(sprintf("unsupported link %s", model$link), call. = FALSE))
}

#' @export
predict.scelo_glm <- function(object, newdata, offset = NULL, ...) sc_predict(object, newdata, offset)

#' Rating relativities from a log-link GLM
#'
#' exp(beta) per categorical level (base = 1) and per unit of each numeric
#' term; the base rate exp(intercept) is in the basis and the `base_rate`
#' attribute. `sc_rate_table()` is the wide view: one column per factor,
#' relativity per level.
#'
#' @param model A `scelo_glm` with a log link.
#' @param base Unused; kept for parity with the Python API.
#' @return `sc_relativities()`: a `scelo_table` of `factor`, `level`,
#'   `relativity`, `estimate`. `sc_rate_table()`: a data frame with one row
#'   per level and one column per factor.
#' @examples
#' m <- sc_glm(sc_sample("claims"), "paid ~ C(line) + age", "gamma")
#' sc_relativities(m)
#' sc_rate_table(m)
#' @export
sc_relativities <- function(model) {
  if (model$link != "log") stop("relativities need a log link", call. = FALSE)
  params <- model$params
  rows <- list()
  for (term in model$terms) {
    pre <- paste0(term, "[")
    keys <- names(params)[startsWith(names(params), pre)]
    if (length(keys)) {
      rows[[length(rows) + 1]] <- data.frame(factor = term, level = trimws(paste(model$base_levels[[term]] %||% "", "(base)")), relativity = 1, estimate = 0, stringsAsFactors = FALSE)
      for (k in keys) {
        rows[[length(rows) + 1]] <- data.frame(factor = term, level = substr(k, nchar(term) + 2, nchar(k) - 1), relativity = exp(params[[k]]), estimate = unname(params[[k]]), stringsAsFactors = FALSE)
      }
    } else if (term %in% names(params)) {
      rows[[length(rows) + 1]] <- data.frame(factor = term, level = "per unit", relativity = exp(params[[term]]), estimate = unname(params[[term]]), stringsAsFactors = FALSE)
    }
  }
  out <- if (length(rows)) do.call(rbind, rows) else data.frame(factor = character(), level = character(), relativity = numeric(), estimate = numeric())
  rownames(out) <- NULL
  base <- exp(params[["Intercept"]])
  t <- sc_table(out, title = sprintf("Relativities · %s", model$formula), basis = sprintf("base rate exp(intercept) = %.6g", base), stage = "hard",
                notes = paste0("Multiply the base rate by one relativity per factor; the base level of each factor is ", if (identical(model$base, "first")) "its alphabetically first level." else if (is.list(model$base)) "as given." else "its most frequent level."))
  attr(t, "base_rate") <- base
  t
}

#' @rdname sc_relativities
#' @export
sc_rate_table <- function(model, base = NULL) {
  r <- sc_relativities(model)
  lv <- sort(unique(r$level), method = "radix")
  fc <- sort(unique(r$factor), method = "radix")
  m <- matrix(NA_real_, length(lv), length(fc), dimnames = list(lv, fc))
  first <- !duplicated(r[c("level", "factor")])
  m[cbind(match(r$level[first], lv), match(r$factor[first], fc))] <- r$relativity[first]
  as.data.frame(m, stringsAsFactors = FALSE, check.names = FALSE)
}

# Sum `cols` of `work` by the `keys` columns (pandas groupby semantics: keys sorted by code point, NA keys dropped, NA values skipped).
.sc_agg_sum <- function(work, keys, cols) {
  if (!length(keys)) {
    out <- as.data.frame(lapply(work[cols], function(v) sum(v, na.rm = TRUE)))
    names(out) <- cols
    return(out)
  }
  ok <- stats::complete.cases(work[keys])
  w <- work[ok, , drop = FALSE]
  ord <- do.call(order, c(unname(lapply(w[keys], function(k) if (is.factor(k)) as.character(k) else k)), list(method = "radix")))
  w <- w[ord, , drop = FALSE]
  key_str <- do.call(paste, c(lapply(w[keys], as.character), sep = "\r"))
  first <- !duplicated(key_str)
  gid <- cumsum(first)
  sums <- rowsum(as.matrix(w[cols]), gid, na.rm = TRUE)
  out <- w[first, keys, drop = FALSE]
  rownames(out) <- NULL
  for (c in cols) out[[c]] <- as.numeric(sums[, c])
  out
}

.sc_append_total <- function(out, keys, tot) {
  for (k in keys) if (!is.character(out[[k]])) out[[k]] <- as.character(out[[k]])
  row <- out[1, , drop = FALSE]
  for (k in keys) row[[k]] <- "total"
  for (nm in names(tot)) row[[nm]] <- tot[[nm]]
  out <- rbind(out, row)
  rownames(out) <- NULL
  out
}

#' Frequency × severity summary by group
#'
#' Exposure, claims, frequency (claims / exposure), severity (amount /
#' claims) and pure premium (amount / exposure) per group, with a total row.
#'
#' @param df A data frame.
#' @param by Grouping column(s); `NULL` for one row.
#' @param count Claim-count column (inferred by alias; absent: a claim is a positive amount).
#' @param amount Claim-amount column (inferred by alias).
#' @param exposure Exposure column (inferred by alias; absent: 1 per row).
#' @return A `scelo_table`.
#' @examples
#' sc_freq_sev(sc_sample("claims"), "line", amount = "paid")
#' @export
sc_freq_sev <- function(df, by = NULL, count = NULL, amount = NULL, exposure = NULL) {
  .sc_tool("sc_freq_sev", list(df = df, by = by, count = count, amount = amount, exposure = exposure), df, {
    c <- sc_infer(df, "count", count, required = FALSE)
    a <- sc_infer(df, "value", amount, required = FALSE)
    e <- sc_infer(df, "exposure", exposure, required = FALSE)
    if (is.null(a) && is.null(c)) stop("need a claim count and/or amount column", call. = FALSE)
    keys <- as.character(by %||% character())
    work <- df[keys]
    work$exposure <- if (!is.null(e)) .sc_num_or_na(df[[e]]) else rep(1, nrow(df))
    amt <- if (!is.null(a)) .sc_num_or_na(df[[a]]) else rep(NA_real_, nrow(df))
    work$claims <- if (!is.null(c)) .sc_num_or_na(df[[c]]) else as.numeric(!is.na(amt) & amt > 0)
    work$amount <- amt
    out <- .sc_agg_sum(work, keys, c("exposure", "claims", "amount"))
    out$frequency <- out$claims / out$exposure
    out$severity <- ifelse(out$claims > 0, out$amount / out$claims, NA_real_)
    out$pure_premium <- out$amount / out$exposure
    if (length(keys)) {
      tot <- list(exposure = sum(out$exposure), claims = sum(out$claims), amount = sum(out$amount))
      tot$frequency <- tot$claims / tot$exposure
      tot$severity <- if (tot$claims != 0) tot$amount / tot$claims else NA_real_
      tot$pure_premium <- tot$amount / tot$exposure
      out <- .sc_append_total(out, keys, tot)
    }
    sc_table(out, title = paste0("Frequency × severity", if (length(keys)) sprintf(" by %s", paste(keys, collapse = ", ")) else ""), stage = "hard",
             notes = "frequency = claims / exposure; severity = amount / claims; pure premium = amount / exposure = frequency × severity.")
  })
}

#' Loss ratio by group
#'
#' Sum of loss over sum of premium per group, with a total row.
#'
#' @param df A data frame.
#' @param by Grouping column(s); `NULL` for one row.
#' @param loss Loss column (inferred by alias).
#' @param premium Premium column (inferred by alias).
#' @return A `scelo_table` of `loss`, `premium`, `loss_ratio`.
#' @examples
#' sc_loss_ratio(data.frame(paid = c(100, 50, 30), premium = c(200, 100, 100), line = c("a", "a", "b")), "line")
#' @export
sc_loss_ratio <- function(df, by = NULL, loss = NULL, premium = NULL) {
  .sc_tool("sc_loss_ratio", list(df = df, by = by, loss = loss, premium = premium), df, {
    lcol <- sc_infer(df, "value", loss)
    pcol <- sc_infer(df, "premium", premium, exclude = lcol)
    keys <- as.character(by %||% character())
    work <- df[keys]
    work$loss <- .sc_num_or_na(df[[lcol]])
    work$premium <- .sc_num_or_na(df[[pcol]])
    out <- .sc_agg_sum(work, keys, c("loss", "premium"))
    out$loss_ratio <- out$loss / out$premium
    if (length(keys)) {
      tot <- list(loss = sum(out$loss), premium = sum(out$premium))
      tot$loss_ratio <- tot$loss / tot$premium
      out <- .sc_append_total(out, keys, tot)
    }
    sc_table(out, title = paste0("Loss ratio", if (length(keys)) sprintf(" by %s", paste(keys, collapse = ", ")) else ""), stage = "hard")
  })
}

#' Burning cost
#'
#' Sum of trended losses over sum of exposure; losses are trended at `trend`
#' p.a. from `years` to `to_year` (the latest year by default).
#'
#' @param df A data frame.
#' @param loss Loss column (inferred by alias).
#' @param exposure Exposure column (inferred by alias).
#' @param trend Annual trend rate.
#' @param years Year column for trending.
#' @param to_year Target year.
#' @return A number.
#' @examples
#' sc_burning_cost(data.frame(loss = c(100, 200), exposure = c(10, 10), year = c(2020, 2021)),
#'                 trend = 0.1, years = "year", to_year = 2021)
#' @export
sc_burning_cost <- function(df, loss = NULL, exposure = NULL, trend = 0, years = NULL, to_year = NULL) {
  lcol <- sc_infer(df, "value", loss)
  ecol <- sc_infer(df, "exposure", exposure, exclude = lcol)
  L <- .sc_num_or_na(df[[lcol]])
  L[is.na(L)] <- 0
  if (!is.null(years) && trend != 0) {
    yrs <- .sc_num_or_na(df[[years]])
    target <- to_year %||% as.integer(max(yrs, na.rm = TRUE))
    L <- L * (1 + trend)^(target - yrs)
  }
  sum(L) / sum(.sc_num_or_na(df[[ecol]]), na.rm = TRUE)
}

#' Lift chart
#'
#' Sort by prediction into `bins` equal-exposure bands and compare the mean
#' actual with the mean predicted per band; the Gini coefficient is in the
#' basis.
#'
#' @param actual Observed values.
#' @param predicted Model predictions.
#' @param bins Number of bands.
#' @param exposure Weights (1 per row when `NULL`).
#' @return A `scelo_table` of `band`, `exposure`, `actual`, `predicted`,
#'   `lift`, `a/e`.
#' @examples
#' claims <- sc_sample("claims")
#' m <- sc_glm(claims, "paid ~ C(line) + age", "gamma")
#' sc_lift(claims$paid, m$fitted, bins = 4)
#' @export
sc_lift <- function(actual, predicted, bins = 10L, exposure = NULL) {
  .sc_tool("sc_lift", list(actual = actual, predicted = predicted, bins = bins, exposure = exposure), NULL, {
    a <- as.numeric(actual)
    p <- as.numeric(predicted)
    w <- if (is.null(exposure)) rep(1, length(a)) else as.numeric(exposure)
    ord <- order(p)
    cw <- cumsum(w[ord]) / sum(w)
    band <- pmin(as.integer(cw * bins), bins - 1L)
    sw <- rowsum(w[ord], band)
    swa <- rowsum((a * w)[ord], band)
    swp <- rowsum((p * w)[ord], band)
    out <- data.frame(band = as.integer(rownames(sw)) + 1L, exposure = sw[, 1], actual = swa[, 1] / sw[, 1], predicted = swp[, 1] / sw[, 1], stringsAsFactors = FALSE, check.names = FALSE)
    rownames(out) <- NULL
    out$lift <- out$actual / (sum(a * w) / sum(w))
    out[["a/e"]] <- out$actual / out$predicted
    g <- sc_gini(a, p, w)
    sc_table(out, title = sprintf("Lift · %d bands", as.integer(bins)), basis = sprintf("Gini %.3f", g), stage = "hard", notes = c(
      "Bands are equal-exposure deciles of the prediction; a/e near 1 across bands means the model is calibrated, a rising `actual` means it discriminates."
    ))
  })
}

#' Gini coefficient of a prediction's ordering
#'
#' Exposure-weighted Gini of the actuals ordered by the prediction (0 = no
#' discrimination).
#'
#' @inheritParams sc_lift
#' @return A number.
#' @examples
#' sc_gini(c(0, 1, 0, 2, 3), c(0.1, 0.5, 0.2, 0.9, 1.2))
#' @export
sc_gini <- function(actual, predicted, exposure = NULL) {
  a <- as.numeric(actual)
  p <- as.numeric(predicted)
  w <- if (is.null(exposure)) rep(1, length(a)) else as.numeric(exposure)
  ord <- order(p)
  a <- a[ord]
  w <- w[ord]
  cum_w <- cumsum(w) / sum(w)
  cum_a <- cumsum(a * w) / sum(a * w)
  area <- sum(diff(cum_w) * (cum_a[-1] + cum_a[-length(cum_a)]) / 2)
  1 - 2 * area
}
