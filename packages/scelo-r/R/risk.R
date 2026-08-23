# Risk: tail measures, aggregate loss, distribution fitting, credibility,
# capital aggregation.
#
# A pricing or capital number is only as good as the distribution behind it,
# so these functions keep the model explicit: sc_aggregate_loss() builds
# S = X1 + ... + XN on a lattice by Panjer recursion or FFT (or by Monte
# Carlo) from a named frequency and severity, sc_fit() ranks maximum-
# likelihood fits of the usual severity families with a KS distance next to
# the AIC, sc_credibility() is Buhlmann-Straub with its EPV / VHM / K in the
# basis line, and sc_aggregate_scr() is the Solvency-II-style square-root
# aggregation with the standard-formula life matrix as default. Everything
# follows packages/scelo-py/src/scelo/risk.py so a VaR printed here is the
# VaR the Python package prints for the same inputs; base R's d/p/r functions
# replace the numpy fallbacks.

.SC_FREQ_KEYS <- c("lam", "r", "beta", "m", "q")
.SC_SEV_KEYS <- c("mu", "sigma", "alpha", "theta", "shape", "scale", "rate")

.sc_split_params <- function(params) {
  list(freq = params[intersect(names(params), .SC_FREQ_KEYS)], sev = params[intersect(names(params), .SC_SEV_KEYS)])
}

.sc_is_negbin <- function(d) d %in% c("negbin", "nbinom", "negative-binomial")

.sc_fmt_g <- function(v) if (is.infinite(v)) if (v > 0) "inf" else "-inf" else sprintf("%g", v)

.sc_fmt_comma <- function(v, digits = 2) formatC(v, format = "f", digits = digits, big.mark = ",")

# ── tail measures ──────────────────────────────────────────────────────────

#' Value at risk and tail value at risk of a loss sample
#'
#' `sc_var()` is the p-quantile (type 7) of the sample; `sc_tvar()` (alias
#' `sc_es()`, expected shortfall) the mean of the sample at or above that
#' quantile. Missing values are dropped.
#'
#' @param x Losses.
#' @param p Probability level (0.995 by default).
#' @return A number (a vector when `p` is one).
#' @examples
#' x <- sc_simulate_losses("poisson", "lognormal", lam = 5, mu = 8, sigma = 1, n_sims = 2000)
#' sc_var(x, 0.99)
#' sc_tvar(x, 0.99)
#' @export
sc_var <- function(x, p = 0.995) {
  arr <- as.numeric(x)
  arr <- arr[!is.na(arr)]
  unname(stats::quantile(arr, p, type = 7, names = FALSE))
}

#' @rdname sc_var
#' @export
sc_tvar <- function(x, p = 0.995) {
  arr <- as.numeric(x)
  arr <- arr[!is.na(arr)]
  vapply(p, function(pp) {
    q <- stats::quantile(arr, pp, type = 7, names = FALSE)
    tail <- arr[arr >= q]
    if (length(tail)) mean(tail) else q
  }, numeric(1))
}

#' @rdname sc_var
#' @export
sc_es <- sc_tvar

# ── aggregate loss ────────────────────────────────────────────────────────

# Frequency pmf on 0..n_max for poisson / negbin / binomial.
.sc_freq_pmf <- function(dist, n_max, params) {
  k <- 0:n_max
  dist <- tolower(dist)
  if (dist == "poisson") return(stats::dpois(k, as.numeric(params$lam)))
  if (.sc_is_negbin(dist)) return(stats::dnbinom(k, size = as.numeric(params$r), prob = 1 / (1 + as.numeric(params$beta))))
  if (dist == "binomial") return(stats::dbinom(k, as.integer(params$m), as.numeric(params$q)))
  stop("frequency must be poisson, negbin or binomial", call. = FALSE)
}

# CDF of a named severity distribution (Loss Models parameterisation) as a function of x.
.sc_cdf <- function(name, kw) {
  name <- tolower(name)
  if (name == "lognormal") {
    mu <- as.numeric(kw$mu); s <- as.numeric(kw$sigma)
    return(function(x) ifelse(x > 0, stats::plnorm(pmax(x, 1e-300), mu, s), 0))
  }
  if (name == "exponential") {
    th <- if (!is.null(kw$theta)) as.numeric(kw$theta) else 1 / (if (!is.null(kw$rate)) as.numeric(kw$rate) else 1)
    return(function(x) ifelse(x > 0, 1 - exp(-x / th), 0))
  }
  if (name == "gamma") {
    a <- as.numeric(kw$alpha); th <- as.numeric(kw$theta)
    return(function(x) ifelse(x > 0, stats::pgamma(pmax(x, 0), shape = a, scale = th), 0))
  }
  if (name == "pareto") {
    a <- as.numeric(kw$alpha); th <- as.numeric(kw$theta)
    return(function(x) ifelse(x > 0, 1 - (th / (th + pmax(x, 0)))^a, 0))
  }
  if (name == "weibull") {
    k <- as.numeric(kw$shape); lam <- as.numeric(kw$scale)
    return(function(x) ifelse(x > 0, 1 - exp(-(pmax(x, 0) / lam)^k), 0))
  }
  stop("severity must be lognormal, exponential, gamma, pareto or weibull", call. = FALSE)
}

# Severity pmf on the lattice 0, h, 2h, ... (rounding method) from a named distribution or an empirical sample.
.sc_discretise <- function(sev, h, n, kw) {
  x <- (0:(n - 1)) * h
  if (is.character(sev)) {
    cdf <- .sc_cdf(sev, kw)
    up <- cdf(x + h / 2)
    lo <- c(0, up[-n])
    f <- up - lo
    f[n] <- f[n] + max(0, 1 - up[n])
    return(f)
  }
  arr <- as.numeric(sev)
  idx <- pmin(pmax(round(arr / h), 0), n - 1)
  tabulate(idx + 1, nbins = n) / length(arr)
}

#' Panjer recursion
#'
#' The aggregate pmf on the severity lattice for a poisson / negbin /
#' binomial frequency (the (a, b, 0) class), given the discretised severity
#' pmf (see [sc_aggregate_loss()], which builds the lattice for you).
#'
#' @param frequency "poisson", "negbin" or "binomial".
#' @param severity Severity pmf on the lattice 0, h, 2h, ...
#' @param ... Frequency parameters: `lam` (poisson), `r` and `beta`
#'   (negbin, mean r * beta), `m` and `q` (binomial).
#' @return The aggregate pmf, same length as `severity`.
#' @examples
#' f <- c(0, 0.5, 0.3, 0.2, rep(0, 60))
#' g <- sc_panjer("poisson", f, lam = 2)
#' sum(g)                          # total mass
#' sum((seq_along(g) - 1) * g)     # mean on the lattice = 2 * E[X]
#' @export
sc_panjer <- function(frequency, severity, ...) {
  if (!is.character(frequency)) stop("pass a frequency name (poisson / negbin / binomial) with its parameters", call. = FALSE)
  fk <- list(...)
  f <- as.numeric(severity)
  n <- length(f)
  dist <- tolower(frequency)
  if (dist == "poisson") {
    lam <- as.numeric(fk$lam)
    a <- 0; b <- lam
    p0 <- exp(-lam * (1 - f[1]))
  } else if (.sc_is_negbin(dist)) {
    r <- as.numeric(fk$r); beta <- as.numeric(fk$beta)
    a <- beta / (1 + beta); b <- (r - 1) * beta / (1 + beta)
    p0 <- (1 + beta * (1 - f[1]))^-r
  } else if (dist == "binomial") {
    m <- as.integer(fk$m); q <- as.numeric(fk$q)
    a <- -q / (1 - q); b <- (m + 1) * q / (1 - q)
    p0 <- (1 + q * (f[1] - 1))^m
  } else {
    stop("Panjer frequency must be poisson, negbin or binomial", call. = FALSE)
  }
  g <- numeric(n)
  g[1] <- p0
  den <- 1 - a * f[1]
  af <- a * f
  bf <- b * f
  for (s in seq_len(n - 1)) {
    j <- seq_len(s)
    g[s + 1] <- sum((af[j + 1] + bf[j + 1] * j / s) * g[s - j + 1]) / den
  }
  g
}

.sc_mean_freq <- function(dist, kw) {
  d <- tolower(dist)
  if (d == "poisson") return(as.numeric(kw$lam))
  if (.sc_is_negbin(d)) return(as.numeric(kw$r) * as.numeric(kw$beta))
  as.numeric(kw$m) * as.numeric(kw$q)
}

.sc_mean_sev <- function(sev, kw) {
  if (!is.character(sev)) return(mean(as.numeric(sev)))
  s <- tolower(sev)
  if (s == "lognormal") return(exp(as.numeric(kw$mu) + as.numeric(kw$sigma)^2 / 2))
  if (s == "exponential") return(if (!is.null(kw$theta)) as.numeric(kw$theta) else 1 / (if (!is.null(kw$rate)) as.numeric(kw$rate) else 1))
  if (s == "gamma") return(as.numeric(kw$alpha) * as.numeric(kw$theta))
  if (s == "pareto") return(if (as.numeric(kw$alpha) > 1) as.numeric(kw$theta) / (as.numeric(kw$alpha) - 1) else Inf)
  if (s == "weibull") return(as.numeric(kw$scale) * gamma(1 + 1 / as.numeric(kw$shape)))
  stop("severity must be lognormal, exponential, gamma, pareto or weibull", call. = FALSE)
}

.sc_sample_freq <- function(dist, kw, n) {
  d <- tolower(dist)
  if (d == "poisson") return(stats::rpois(n, as.numeric(kw$lam)))
  if (.sc_is_negbin(d)) return(stats::rnbinom(n, size = as.numeric(kw$r), prob = 1 / (1 + as.numeric(kw$beta))))
  stats::rbinom(n, as.integer(kw$m), as.numeric(kw$q))
}

.sc_sample_sev <- function(sev, kw, n) {
  if (!is.character(sev)) return(sample(as.numeric(sev), n, replace = TRUE))
  s <- tolower(sev)
  if (s == "lognormal") return(stats::rlnorm(n, as.numeric(kw$mu), as.numeric(kw$sigma)))
  if (s == "exponential") return(stats::rexp(n, 1 / (if (!is.null(kw$theta)) as.numeric(kw$theta) else 1 / (if (!is.null(kw$rate)) as.numeric(kw$rate) else 1))))
  if (s == "gamma") return(stats::rgamma(n, shape = as.numeric(kw$alpha), scale = as.numeric(kw$theta)))
  if (s == "pareto") return(as.numeric(kw$theta) * ((1 - stats::runif(n))^(-1 / as.numeric(kw$alpha)) - 1))
  if (s == "weibull") return(stats::rweibull(n, shape = as.numeric(kw$shape), scale = as.numeric(kw$scale)))
  stop("severity must be lognormal, exponential, gamma, pareto or weibull", call. = FALSE)
}

# Aggregate the severities X into per-simulation totals given the counts N (sum(N) == length(X)).
.sc_aggregate_sims <- function(N, X, n_sims) {
  S <- numeric(n_sims)
  if (length(X)) {
    agg <- rowsum(X, rep(seq_len(n_sims), N))
    S[as.integer(rownames(agg))] <- agg[, 1]
  }
  S
}

#' Aggregate loss distribution
#'
#' S = X1 + ... + XN for a named frequency and severity: mean, sd, and VaR /
#' TVaR at the `quantiles`, by Panjer recursion (exact on a lattice of step
#' `h`), FFT (same lattice, any frequency) or Monte Carlo.
#'
#' @param frequency poisson(`lam`) / negbin(`r`, `beta`) / binomial(`m`, `q`).
#' @param severity lognormal(`mu`, `sigma`) / gamma(`alpha`, `theta`) /
#'   pareto(`alpha`, `theta`, Lomax) / exponential(`theta`) / weibull(`shape`,
#'   `scale`), or a numeric vector: an empirical severity sample.
#' @param method "panjer", "fft" or "mc".
#' @param h Lattice step; by default 20 mean aggregate losses spread over
#'   `n` points.
#' @param n Lattice points.
#' @param n_sims Monte Carlo simulations (method "mc").
#' @param seed Seed for method "mc" (`NULL` leaves the RNG alone).
#' @param quantiles Probability levels for the VaR / TVaR rows.
#' @param ... Frequency and severity parameters by name (`lam`, `r`, `beta`,
#'   `m`, `q`; `mu`, `sigma`, `alpha`, `theta`, `shape`, `scale`, `rate`).
#'   They come before the options so that `q = ` and `m = ` can never be
#'   mistaken for `quantiles` or `method`: give the options by full name.
#' @return A `scelo_table` of `p`, `VaR`, `TVaR` with attributes `mean` and `sd`.
#' @examples
#' a <- sc_aggregate_loss("poisson", "lognormal", lam = 5, mu = 8, sigma = 1, h = 100, n = 1024)
#' a
#' attr(a, "mean")
#' @export
sc_aggregate_loss <- function(frequency = "poisson", severity = "lognormal", ..., method = "panjer", h = NULL, n = 4096L, n_sims = 100000L, seed = 42L,
                              quantiles = c(0.5, 0.75, 0.9, 0.95, 0.99, 0.995)) {
  params <- list(...)
  if (length(params) && (is.null(names(params)) || any(!nzchar(names(params))))) stop("frequency and severity parameters must be named (lam = , mu = , sigma = , ...)", call. = FALSE)
  .sc_tool("sc_aggregate_loss", c(list(frequency = frequency, severity = severity, method = method, h = h, n = n), params), NULL, {
    sp <- .sc_split_params(params)
    fk <- sp$freq
    sk <- sp$sev
    n <- as.integer(n)
    if (method == "mc") {
      if (!is.null(seed)) set.seed(seed)
      N <- .sc_sample_freq(frequency, fk, n_sims)
      X <- .sc_sample_sev(severity, sk, sum(N))
      S <- .sc_aggregate_sims(N, X, n_sims)
      mean <- mean(S)
      sd <- stats::sd(S)
      qs <- stats::quantile(S, quantiles, type = 7, names = FALSE)
      tv <- vapply(qs, function(q) if (any(S >= q)) mean(S[S >= q]) else q, numeric(1))
      basis <- sprintf("Monte Carlo · %s simulations", format(n_sims, big.mark = ",", scientific = FALSE))
    } else {
      if (is.null(h)) {
        mean_sev <- .sc_mean_sev(severity, sk)
        mean_n <- .sc_mean_freq(frequency, fk)
        h <- max(mean_sev * mean_n * 20 / n, 1e-9)
      }
      f <- .sc_discretise(severity, h, n, sk)
      if (method == "panjer") {
        g <- do.call(sc_panjer, c(list(frequency, f), fk))
      } else {
        pn <- .sc_freq_pmf(frequency, n, fk)
        phi <- stats::fft(f)
        pgf <- complex(n)
        for (p_ in rev(pn)) pgf <- pgf * phi + p_   # P_N(z) = sum p_n z^n at z = phi (Horner)
        g <- Re(stats::fft(pgf, inverse = TRUE)) / n
        g <- pmax(g, 0)
        g <- g / sum(g)
      }
      x <- (0:(n - 1)) * h
      mean <- sum(x * g)
      sd <- sqrt(max(sum(x * x * g) - mean^2, 0))
      cdf <- cumsum(g)
      qs <- vapply(quantiles, function(q) { i <- match(TRUE, cdf >= q); x[if (is.na(i)) n else i] }, numeric(1))
      tv <- vapply(qs, function(q) { m <- x >= q; if (sum(g[m]) > 0) sum(x[m] * g[m]) / sum(g[m]) else q }, numeric(1))
      basis <- sprintf("%s · lattice h = %s × %d", method, .sc_fmt_g(h), n)
      if (cdf[n] < 0.999) basis <- paste0(basis, " · WARNING lattice too short")
    }
    out <- data.frame(p = quantiles, VaR = qs, TVaR = tv)
    fk_txt <- paste(sprintf("%s=%s", names(fk), vapply(fk, function(v) .sc_fmt_g(as.numeric(v)), character(1))), collapse = ", ")
    cv <- if (mean != 0) sd / mean else NaN
    t <- sc_table(out, title = sprintf("Aggregate loss · %s(%s) × %s", frequency, fk_txt, if (is.character(severity)) severity else "empirical"),
                  basis = basis, stage = "hard", notes = sprintf("Mean %s · sd %s · CV %.3f.", .sc_fmt_comma(mean), .sc_fmt_comma(sd), cv))
    attr(t, "mean") <- mean
    attr(t, "sd") <- sd
    t
  })
}

#' Simulated aggregate annual losses
#'
#' One aggregate loss per simulation for the frequency × severity model of
#' [sc_aggregate_loss()], using R's RNG (`set.seed(seed)`).
#'
#' @inheritParams sc_aggregate_loss
#' @return A numeric vector of length `n_sims`.
#' @examples
#' S <- sc_simulate_losses("poisson", "lognormal", lam = 5, mu = 8, sigma = 1, n_sims = 1000)
#' mean(S)
#' @export
sc_simulate_losses <- function(frequency = "poisson", severity = "lognormal", ..., n_sims = 10000L, seed = 42L) {
  if (!is.null(seed)) set.seed(seed)
  sp <- .sc_split_params(list(...))
  N <- .sc_sample_freq(frequency, sp$freq, n_sims)
  X <- .sc_sample_sev(severity, sp$sev, sum(N))
  .sc_aggregate_sims(N, X, n_sims)
}

# ── distribution fitting ──────────────────────────────────────────────────

#' Lognormal parameters from a mean and sd
#'
#' @param mean Mean of the lognormal.
#' @param sd Standard deviation.
#' @return `c(mu = , sigma = )`.
#' @examples
#' sc_lognormal_params(1000, 500)
#' @export
sc_lognormal_params <- function(mean, sd) {
  s2 <- log(1 + (sd / mean)^2)
  c(mu = log(mean) - s2 / 2, sigma = sqrt(s2))
}

.sc_mle <- function(dist, x) {
  n <- length(x)
  lx <- log(x)
  if (dist == "lognormal") {
    mu <- mean(lx)
    s <- sqrt(mean((lx - mu)^2))
    ll <- sum(-lx - log(s * sqrt(2 * pi)) - (lx - mu)^2 / (2 * s * s))
    return(list(params = list(mu = mu, sigma = s), ll = ll))
  }
  if (dist == "exponential") {
    th <- mean(x)
    return(list(params = list(theta = th), ll = -n * log(th) - sum(x) / th))
  }
  if (dist == "pareto") {
    # Lomax (Pareto type II): theta profiled over a geometric grid around the data scale, alpha closed-form given theta
    grid <- exp(seq(log(min(x) / 10), log(max(x) * 10), length.out = 200))
    best <- NULL
    for (th in grid) {
      a <- n / sum(log1p(x / th))
      ll <- n * log(a) + n * a * log(th) - (a + 1) * sum(log(x + th))
      if (is.null(best) || ll > best$ll) best <- list(params = list(alpha = a, theta = th), ll = ll)
    }
    return(best)
  }
  if (dist == "gamma") {
    s <- log(mean(x)) - mean(lx)
    a <- (3 - s + sqrt((s - 3)^2 + 24 * s)) / (12 * s)
    for (i in 1:50) a <- a - (log(a) - digamma(a) - s) / (1 / a - trigamma(a))   # Newton on the profile likelihood
    th <- mean(x) / a
    ll <- sum((a - 1) * lx - x / th - a * log(th) - lgamma(a))
    return(list(params = list(alpha = a, theta = th), ll = ll))
  }
  if (dist == "weibull") {
    k <- 1
    for (i in 1:100) {   # Newton for the shape
      xk <- x^k
      g <- sum(xk * lx) / sum(xk) - 1 / k - mean(lx)
      gp <- (sum(xk * lx * lx) * sum(xk) - sum(xk * lx)^2) / sum(xk)^2 + 1 / k^2
      k_new <- k - g / gp
      if (abs(k_new - k) < 1e-10) {
        k <- k_new
        break
      }
      k <- max(k_new, 1e-3)
    }
    lam <- (sum(x^k) / n)^(1 / k)
    ll <- sum(log(k) - k * log(lam) + (k - 1) * lx - (x / lam)^k)
    return(list(params = list(shape = k, scale = lam), ll = ll))
  }
  stop(sprintf("unknown distribution %s", dist), call. = FALSE)
}

#' Maximum-likelihood severity fits
#'
#' Fits of the usual severity families to a positive sample, ranked by AIC,
#' with the parameters in Loss Models notation (lognormal mu sigma, gamma
#' alpha theta, pareto alpha theta, weibull shape scale, exponential theta),
#' the log-likelihood and a Kolmogorov-Smirnov distance.
#'
#' @param x A sample (non-positive and missing values are dropped).
#' @param dists Families to fit.
#' @return A `scelo_table` with `distribution`, `params`, `loglik`, `aic`,
#'   `ks` and one `p_<name>` column per parameter.
#' @examples
#' sc_fit(rlnorm(300, 8, 1))
#' @export
sc_fit <- function(x, dists = c("lognormal", "gamma", "pareto", "weibull", "exponential")) {
  .sc_tool("sc_fit", list(x = x, dists = dists), NULL, {
    arr <- as.numeric(x)
    arr <- arr[!is.na(arr)]
    arr <- arr[arr > 0]
    n <- length(arr)
    if (n < 5) stop("need at least 5 positive observations", call. = FALSE)
    xs <- sort(arr)
    emp_hi <- (1:n) / n
    emp_lo <- (0:(n - 1)) / n
    rows <- lapply(dists, function(d) {
      fit <- tryCatch(.sc_mle(d, arr), error = function(e) e)
      if (inherits(fit, "error")) return(list(distribution = d, params = paste("failed:", conditionMessage(fit)), loglik = NA_real_, aic = NA_real_, ks = NA_real_))
      params <- fit$params
      k <- length(params)
      F <- .sc_cdf(d, params)(xs)
      ks <- max(max(abs(emp_hi - F)), max(abs(F - emp_lo)))
      row <- list(distribution = d, params = paste(sprintf("%s=%.6g", names(params), unlist(params)), collapse = ", "), loglik = fit$ll, aic = 2 * k - 2 * fit$ll, ks = ks)
      for (nm in names(params)) row[[paste0("p_", nm)]] <- params[[nm]]
      row
    })
    cols <- unique(unlist(lapply(rows, names)))
    out <- as.data.frame(lapply(cols, function(c) {
      v <- lapply(rows, function(r) if (is.null(r[[c]])) NA else r[[c]])
      if (c %in% c("distribution", "params")) vapply(v, as.character, character(1)) else vapply(v, as.numeric, numeric(1))
    }), stringsAsFactors = FALSE)
    names(out) <- cols
    out <- out[order(out$aic), , drop = FALSE]
    rownames(out) <- NULL
    sc_table(out, title = sprintf("Severity fits · n = %s", format(n, big.mark = ",")), basis = "maximum likelihood", stage = "hard", notes = c(
      "Ranked by AIC (lower is better); KS is the empirical-vs-fitted sup distance. Lognormal / exponential / pareto are closed-form MLEs; gamma and weibull are numerical."
    ))
  })
}

# ── credibility ───────────────────────────────────────────────────────────

#' Buhlmann-Straub credibility by group
#'
#' Z = n / (n + K) with K = EPV / VHM, credibility premium Z * mean_g +
#' (1 - Z) * mu. `value` is the per-record observation (loss ratio, claim
#' count, ...), `weight` the exposure (1 when absent: plain Buhlmann). Groups
#' with one record get Z from the collective K like the rest. `sc_buhlmann()`
#' is an alias.
#'
#' @param df A data frame.
#' @param group Group column (inferred by alias when `NULL`).
#' @param value Observation column (first numeric column when `NULL`).
#' @param weight Exposure column, or `NULL` for unit weights.
#' @return A `scelo_table` with the group column, `n`, `weight`, `mean`, `Z`,
#'   `credibility_premium`, largest weight first; EPV / VHM / K in the basis.
#' @examples
#' df <- data.frame(group = rep(c("A", "B", "C"), c(6, 4, 2)),
#'                  lr = c(0.7, 0.8, 0.65, 0.75, 0.7, 0.72, 0.9, 0.95, 0.85, 0.88, 0.5, 0.55))
#' sc_credibility(df)
#' @export
sc_credibility <- function(df, group = NULL, value = NULL, weight = NULL) {
  .sc_tool("sc_credibility", list(df = df, group = group, value = value, weight = weight), df, {
    g <- sc_infer(df, "group", group)
    vcol <- value
    if (is.null(vcol)) {
      cand <- setdiff(.sc_numeric_columns(df), c(g, weight))
      if (length(cand)) vcol <- cand[1]
    }
    if (is.null(vcol)) stop("pass value=<numeric column>", call. = FALSE)
    w <- if (!is.null(weight)) .sc_num_or_na(df[[weight]]) else rep(1, nrow(df))
    x <- .sc_num_or_na(df[[vcol]])
    gv <- df[[g]]
    if (is.factor(gv)) gv <- as.character(gv)
    keep <- !is.na(gv) & !is.na(x) & !is.na(w)
    gv <- gv[keep]; x <- x[keep]; w <- w[keep]
    gl <- sort(unique(gv), method = "radix")
    gi <- match(gv, gl)
    G <- length(gl)
    w_g <- as.numeric(rowsum(w, gi))
    m_g <- as.numeric(rowsum(w * x, gi)) / w_g
    n_g <- tabulate(gi, G)
    mu <- sum(w * x) / sum(w)
    # EPV (within) and VHM (between), Buhlmann-Straub estimators
    r <- w * (x - m_g[gi])^2
    multi <- n_g[gi] > 1
    within <- sum(r[multi])
    dof <- sum(n_g[n_g > 1] - 1)
    epv <- if (dof > 0) within / dof else 0
    W <- sum(w_g)
    between_num <- sum(w_g * (m_g - mu)^2) - epv * (G - 1)
    between_den <- W - sum(w_g^2) / W
    vhm <- if (between_den > 0) max(between_num / between_den, 0) else 0
    K <- if (vhm > 0) epv / vhm else Inf
    Z <- if (is.finite(K)) w_g / (w_g + K) else rep(0, G)
    prem <- Z * m_g + (1 - Z) * mu
    out <- data.frame(gl, n = n_g, weight = w_g, mean = m_g, Z = Z, credibility_premium = prem, stringsAsFactors = FALSE)
    names(out)[1] <- g
    out <- out[order(-out$weight), , drop = FALSE]
    rownames(out) <- NULL
    g4 <- function(v) if (is.infinite(v)) "inf" else sprintf("%.4g", v)
    sc_table(out, title = sprintf("Bühlmann–Straub credibility · %s by %s", vcol, g), basis = sprintf("μ %s · EPV %s · VHM %s · K %s", g4(mu), g4(epv), g4(vhm), g4(K)), stage = "hard", notes = c(
      "Z = w/(w + K) with K = EPV/VHM; the credibility premium shrinks each group's mean toward the collective mean μ. VHM ≤ 0 gives K = ∞ and Z = 0: the groups are not distinguishable from noise."
    ))
  })
}

#' @rdname sc_credibility
#' @export
sc_buhlmann <- sc_credibility

#' Limited-fluctuation (classical) credibility
#'
#' Full-credibility standard n0 = (z / k)^2 * (1 + cv^2) claims for
#' probability `p` within `k`; `Z = min(1, sqrt(n / n0))` when `partial`.
#' `sc_full_credibility()` returns n0 itself.
#'
#' @param n Observed claim count.
#' @param p Probability.
#' @param k Tolerance (relative).
#' @param cv Severity coefficient of variation (`NULL` for counts only).
#' @param partial Return Z (`TRUE`) or the standard n0 (`FALSE`).
#' @return A number.
#' @examples
#' sc_full_credibility(0.9, 0.05)
#' sc_limited_fluctuation(270.5, p = 0.9, k = 0.05)
#' @export
sc_limited_fluctuation <- function(n, p = 0.9, k = 0.05, cv = NULL, partial = TRUE) {
  z <- stats::qnorm((1 + p) / 2)
  n0 <- (z / k)^2 * (1 + (cv %||% 0)^2)
  if (partial) min(1, sqrt(n / n0)) else n0
}

#' @rdname sc_limited_fluctuation
#' @export
sc_full_credibility <- function(p = 0.9, k = 0.05, cv = NULL) sc_limited_fluctuation(0, p = p, k = k, cv = cv, partial = FALSE)

# ── capital aggregation ───────────────────────────────────────────────────

.sc_corr_matrix <- function(values, names) matrix(values, length(names), length(names), byrow = TRUE, dimnames = list(names, names))

#' Solvency II standard-formula correlation matrices
#'
#' `SC_SII_LIFE_CORR`: life underwriting (Delegated Regulation Annex IV);
#' `SC_SII_NONLIFE_CORR`: non-life underwriting sub-modules;
#' `SC_SII_BSCR_CORR`: BSCR top level (market, counterparty default, life,
#' health, non-life).
#' @format Square numeric matrices with module names as dimnames.
#' @export
SC_SII_LIFE_CORR <- .sc_corr_matrix(c(
  1, -0.25, 0.25, 0, 0.25, 0, 0.25,
  -0.25, 1, 0, 0.25, 0.25, 0.25, 0,
  0.25, 0, 1, 0, 0.5, 0, 0.25,
  0, 0.25, 0, 1, 0.5, 0, 0.25,
  0.25, 0.25, 0.5, 0.5, 1, 0.5, 0.25,
  0, 0.25, 0, 0, 0.5, 1, 0,
  0.25, 0, 0.25, 0.25, 0.25, 0, 1
), c("mortality", "longevity", "disability", "lapse", "expense", "revision", "cat"))

#' @rdname SC_SII_LIFE_CORR
#' @export
SC_SII_NONLIFE_CORR <- .sc_corr_matrix(c(1, 0, 0.25, 0, 1, 0.25, 0.25, 0.25, 1), c("premium_reserve", "lapse", "cat"))

#' @rdname SC_SII_LIFE_CORR
#' @export
SC_SII_BSCR_CORR <- .sc_corr_matrix(c(
  1, 0.25, 0.25, 0.25, 0.25,
  0.25, 1, 0.25, 0.25, 0.5,
  0.25, 0.25, 1, 0.25, 0,
  0.25, 0.25, 0.25, 1, 0,
  0.25, 0.5, 0, 0, 1
), c("market", "default", "life", "health", "non_life"))

#' Square-root capital aggregation
#'
#' SCR = sqrt(v' rho v) of module capital charges with a correlation matrix
#' (default: the SII life matrix). Modules absent from the matrix are treated
#' as uncorrelated with the rest (rho = 0); the table shows each module's
#' charge, its marginal (Euler) contribution v_i * (rho v)_i / SCR and the
#' diversification benefit.
#'
#' @param modules Named numeric vector (or named list) of capital charges.
#' @param corr Correlation matrix (or data frame) with module names as
#'   dimnames; `NULL` for [SC_SII_LIFE_CORR].
#' @return A `scelo_table` with `module`, `charge`, `marginal`, `share` and
#'   the rows `sum`, `SCR`, `diversification`.
#' @examples
#' sc_aggregate_scr(c(mortality = 100, longevity = 50, lapse = 200, expense = 80, cat = 40))
#' @export
sc_aggregate_scr <- function(modules, corr = NULL) {
  .sc_tool("sc_aggregate_scr", list(modules = modules, corr = corr), NULL, {
    v <- unlist(modules)
    nms <- names(v)
    if (is.null(nms) || any(!nzchar(nms))) stop("modules must be named", call. = FALSE)
    v <- as.numeric(v)
    rho <- if (is.null(corr)) SC_SII_LIFE_CORR else as.matrix(corr)
    R <- diag(length(nms))
    dimnames(R) <- list(nms, nms)
    ra <- intersect(nms, rownames(rho))
    rb <- intersect(nms, colnames(rho))
    if (length(ra) && length(rb)) R[ra, rb] <- rho[ra, rb]
    Rv <- as.vector(R %*% v)
    scr <- sqrt(max(sum(v * Rv), 0))
    contrib <- if (scr > 0) v * Rv / scr else 0 * v
    share <- if (scr > 0) contrib / scr else rep(NA_real_, length(v))
    out <- data.frame(module = c(nms, "sum", "SCR", "diversification"), charge = c(v, sum(v), scr, scr - sum(v)),
                      marginal = c(contrib, NA, NA, NA), share = c(share, NA, NA, NA), stringsAsFactors = FALSE)
    div <- if (sum(v) != 0) 1 - scr / sum(v) else 0
    sc_table(out, title = "Capital aggregation", basis = if (is.null(corr)) "SII life correlation matrix" else "given correlation matrix", stage = "hard", notes = c(
      sprintf("SCR = √(vᵀρv) = %s vs undiversified sum %s (%.1f%% diversification). Marginal contributions (Euler) sum to the SCR.", .sc_fmt_comma(scr, 0), .sc_fmt_comma(sum(v), 0), 100 * div)
    ))
  })
}
