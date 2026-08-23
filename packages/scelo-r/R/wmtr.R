# WMTR: the W(M, T, R) survival forecast, ported from the Scelo swarm engine.
#
# W = M^aM * T^aT * R^aR (material x time x relational capital) evolves year
# by year under Poisson shocks; a Cox-style hazard h = h0 * (W/W0)^-beta
# accumulates survival; each Monte Carlo path is classified grew /
# stabilized / declined / collapsed. This is a line-for-line port of
# apps/swarm/src/shared/wmtr.ts (itself ported from
# intelligentactuaries/nanoeconomics-simulation) and of scelo-py's wmtr.py,
# down to the Mulberry32 random stream, so sc_wmtr(..., seed = 42) here gives
# the numbers the IDE's forecast card and the swarm's evidence block give.
# The 32-bit unsigned arithmetic is done in doubles (exact below 2^53): a
# split multiply for Math.imul, XOR on 16-bit halves, floor division for
# the unsigned shifts. The stream has a closed form (state_n = seed + n * C
# mod 2^32), so draws are generated in vectorised blocks: the path loop is
# sequential because the dynamics are, the random numbers are not.
#
# sc_wmtr("rural village under a severe drought") derives the configuration
# from the scenario text the way the IDE's forecast family does (word-bounded
# cue matching, FNV-1a seed), then runs it. sc_wmtr(df) reads a scenario row
# (the wmtr-scenarios sample). Pass any parameter by name to override.

# ── RNG (Mulberry32, bit-exact with the TypeScript) ───────────────────────

.SC_2POW32 <- 4294967296

# (a * b) mod 2^32 for a, b in [0, 2^32): Math.imul on unsigned operands.
.sc_imul32 <- function(a, b) (((a %/% 65536) * b) %% 65536 * 65536 + (a %% 65536) * b) %% .SC_2POW32

# Bitwise XOR / OR of unsigned 32-bit values held in doubles, 16 bits at a time
# (bitwXor works on signed int32, and 2^31 would be NA_integer_).
.sc_xor32 <- function(a, b) bitwXor(a %/% 65536, b %/% 65536) * 65536 + bitwXor(a %% 65536, b %% 65536)
.sc_or32 <- function(a, b) bitwOr(a %/% 65536, b %/% 65536) * 65536 + bitwOr(a %% 65536, b %% 65536)

#' Mulberry32: the swarm's seedable RNG
#'
#' The same seed gives the same stream as Scelo IDE and the swarm engine
#' (`apps/swarm/src/shared/wmtr.ts`), bit for bit. The closure returns `n`
#' uniforms in `[0, 1)` per call; the Monte Carlo consumes them one at a
#' time in the engine's order.
#' @param seed An integer seed (reduced modulo 2^32 like JavaScript's `>>> 0`).
#' @return A function `rand(n = 1)` returning `n` draws and advancing the state.
#' @examples
#' r <- sc_mulberry32(42)
#' r()      # 0.6011037519201636
#' r(3)
#' @export
sc_mulberry32 <- function(seed) {
  s <- trunc(as.numeric(seed)) %% .SC_2POW32
  block <- function(m) { # m <= 2^20 keeps s + k * 0x6D2B79F5 below 2^52, i.e. exact
    t <- (s + seq_len(m) * 1831565813) %% .SC_2POW32 # 0x6D2B79F5 added k times
    s <<- t[m]
    t <- .sc_imul32(.sc_xor32(t, t %/% 32768), .sc_or32(t, 1))
    t <- .sc_xor32(t, (t + .sc_imul32(.sc_xor32(t, t %/% 128), .sc_or32(t, 61))) %% .SC_2POW32)
    .sc_xor32(t, t %/% 16384) / .SC_2POW32
  }
  function(n = 1L) {
    n <- as.integer(n)
    if (is.na(n) || n < 1L) return(numeric())
    if (n <= 1048576L) return(block(n))
    out <- numeric(n)
    done <- 0L
    while (done < n) {
      m <- min(1048576L, n - done)
      out[done + seq_len(m)] <- block(m)
      done <- done + m
    }
    out
  }
}

# One-at-a-time draws from a vectorised stream: refills a block when it runs out.
.sc_rng_buffer <- function(rand, block = 4096L) {
  buf <- rand(block)
  pos <- 0L
  function() {
    pos <<- pos + 1L
    if (pos > block) {
      buf <<- rand(block)
      pos <<- 1L
    }
    buf[pos]
  }
}

.sc_gauss <- function(nxt, mu = 0, sigma = 1) {
  u1 <- max(nxt(), 1e-12)
  u2 <- nxt()
  mu + sigma * sqrt(-2 * log(u1)) * cos(2 * pi * u2)
}

.sc_poisson <- function(nxt, lam) {
  L <- exp(-lam)
  k <- 0L
  p <- 1
  repeat {
    k <- k + 1L
    p <- p * nxt()
    if (p <= L) break
  }
  k - 1L
}

.sc_clamp <- function(x, lo, hi) max(lo, min(hi, x))

# ── wealth, spatial, relational ─────────────────────────────────────────

.sc_compute_w <- function(M, T, R, aM, aT, aR) max(M, 1e-9)^aM * max(T, 1e-9)^aT * max(R, 1e-9)^aR

.SC_SPATIAL_PEAK <- 250
.SC_SPATIAL_K <- 0.015 * 3
.SC_SPATIAL_LOW <- 100
.SC_SPATIAL_HIGH <- 400

.sc_spatial_r <- function(sqft) {
  if (sqft < 0) return(0)
  left <- 1 / (1 + exp(-.SC_SPATIAL_K * (sqft - .SC_SPATIAL_LOW)))
  right <- 1 - 1 / (1 + exp(-.SC_SPATIAL_K * (sqft - .SC_SPATIAL_HIGH)))
  raw <- left * right
  pk_left <- 1 / (1 + exp(-.SC_SPATIAL_K * (.SC_SPATIAL_PEAK - .SC_SPATIAL_LOW)))
  pk_right <- 1 - 1 / (1 + exp(-.SC_SPATIAL_K * (.SC_SPATIAL_PEAK - .SC_SPATIAL_HIGH)))
  peak <- pk_left * pk_right
  if (peak <= 0) 0 else .sc_clamp(raw / peak, 0, 1)
}

.sc_compute_r <- function(family, religion, sqft, wF, wRel, wS) {
  total <- wF + wRel + wS
  t <- if (total > 0) total else 1
  (wF / t) * family + (wRel / t) * religion + (wS / t) * .sc_spatial_r(sqft)
}

# ── shocks ────────────────────────────────────────────────────────────────

#' Shock environments
#'
#' Poisson rate, Normal severity and scope probabilities of the three shock
#' environments (`mild`, `moderate`, `severe`), as in the engine.
#' @format A named list of named lists (`lam`, `mu`, `sd`, `pLocal`,
#'   `pRegional`, `pGlobal`, `pIdio`).
#' @export
SC_SHOCK_PARAMS <- list(
  mild = list(lam = 0.10, mu = 0.08, sd = 0.04, pLocal = 0.35, pRegional = 0.10, pGlobal = 0.02, pIdio = 0.53),
  moderate = list(lam = 0.25, mu = 0.15, sd = 0.08, pLocal = 0.35, pRegional = 0.20, pGlobal = 0.05, pIdio = 0.40),
  severe = list(lam = 0.45, mu = 0.25, sd = 0.12, pLocal = 0.30, pRegional = 0.30, pGlobal = 0.15, pIdio = 0.25)
)

.SC_TARGETS <- c("material", "time", "family", "religion", "meaning_crisis", "combined")
.SC_TARGET_WEIGHTS <- c(0.35, 0.2, 0.15, 0.1, 0.1, 0.1)

.sc_pick_target <- function(nxt) {
  r <- nxt()
  for (i in seq_along(.SC_TARGETS)) {
    r <- r - .SC_TARGET_WEIGHTS[i]
    if (r <= 0) return(.SC_TARGETS[i])
  }
  "material"
}

# One year's shocks: the Poisson count, then per shock a severity (two draws)
# and a target (one draw), in the engine's order.
.sc_single_shocks <- function(nxt, env) {
  p <- SC_SHOCK_PARAMS[[env]]
  n <- .sc_poisson(nxt, p$lam)
  if (n == 0L) return(NULL)
  targets <- character(n)
  sev <- numeric(n)
  for (i in seq_len(n)) {
    sev[i] <- .sc_clamp(.sc_gauss(nxt, p$mu, p$sd), 0.01, 0.9)
    targets[i] <- .sc_pick_target(nxt)
  }
  list(targets = targets, sev = sev)
}

# ── parameters ────────────────────────────────────────────────────────────

.SC_WMTR_FIELDS <- c("population", "sqftPerResident", "alphaM", "alphaT", "alphaR", "wF", "wRel", "wS", "pProduction", "pFamily", "pReligion",
                     "pSpatial", "pLeisure", "initFamily", "initReligion", "shock", "collapse", "recovery", "growth", "stability", "horizon", "nPaths", "seed")

#' The parameters a council intervention may shift
#'
#' @format A character vector.
#' @export
SC_INTERVENTION_PARAMS <- c("alphaM", "alphaT", "alphaR", "wF", "wRel", "wS", "pProduction", "pFamily", "pReligion", "pSpatial", "pLeisure",
                            "initFamily", "initReligion", "shock")

.SC_H0 <- 0.02
.SC_BETA_W <- 2

#' WMTR forecast parameters
#'
#' Single-community forecast parameters (`DEFAULT_WMTR_SINGLE_PARAMS` in
#' the engine). Every argument has the engine's default; `thresholds` may
#' carry the four outcome thresholds as one list (the shape the swarm's
#' `/api/wmtr` config uses).
#' @param population Residents (informational).
#' @param sqftPerResident Floor space per resident, the spatial input to R.
#' @param alphaM,alphaT,alphaR Cobb-Douglas exponents of material, time and relational capital (normalised to sum to 1 when run).
#' @param wF,wRel,wS Weights of family, religion and space inside R.
#' @param pProduction,pFamily,pReligion,pSpatial,pLeisure Time allocation (normalised to sum to 1 when run).
#' @param initFamily,initReligion Initial family and religion capital in `[0, 1]`.
#' @param shock `"mild"`, `"moderate"` or `"severe"` (see [SC_SHOCK_PARAMS]).
#' @param collapse,recovery,growth,stability Outcome thresholds: collapsed below `collapse * W0` for `recovery` consecutive years; grew above `1 + growth`; declined below `1 - stability`.
#' @param horizon Years simulated.
#' @param nPaths Monte Carlo paths.
#' @param seed Mulberry32 seed.
#' @param thresholds Optional list with `collapse`, `recovery`, `growth`, `stability` (overrides the four scalars).
#' @return A list of class `scelo_wmtr_params`.
#' @examples
#' sc_wmtr_params(shock = "severe", horizon = 10)
#' @export
sc_wmtr_params <- function(population = 500, sqftPerResident = 300, alphaM = 0.4, alphaT = 0.3, alphaR = 0.3, wF = 0.4, wRel = 0.3, wS = 0.3,
                           pProduction = 0.4, pFamily = 0.25, pReligion = 0.15, pSpatial = 0.1, pLeisure = 0.1, initFamily = 0.7, initReligion = 0.6,
                           shock = "moderate", collapse = 0.3, recovery = 5, growth = 0.2, stability = 0.1, horizon = 30, nPaths = 200, seed = 42,
                           thresholds = NULL) {
  if (!is.null(thresholds)) {
    if (!is.null(thresholds$collapse)) collapse <- thresholds$collapse
    if (!is.null(thresholds$recovery)) recovery <- thresholds$recovery
    if (!is.null(thresholds$growth)) growth <- thresholds$growth
    if (!is.null(thresholds$stability)) stability <- thresholds$stability
  }
  p <- list(population = as.numeric(population), sqftPerResident = as.numeric(sqftPerResident), alphaM = as.numeric(alphaM), alphaT = as.numeric(alphaT),
            alphaR = as.numeric(alphaR), wF = as.numeric(wF), wRel = as.numeric(wRel), wS = as.numeric(wS), pProduction = as.numeric(pProduction),
            pFamily = as.numeric(pFamily), pReligion = as.numeric(pReligion), pSpatial = as.numeric(pSpatial), pLeisure = as.numeric(pLeisure),
            initFamily = as.numeric(initFamily), initReligion = as.numeric(initReligion), shock = tolower(as.character(shock)),
            collapse = as.numeric(collapse), recovery = as.numeric(recovery), growth = as.numeric(growth), stability = as.numeric(stability),
            horizon = as.integer(horizon), nPaths = as.integer(nPaths), seed = as.numeric(seed))
  structure(p, class = c("scelo_wmtr_params", "list"))
}

#' @rdname sc_wmtr_params
#' @format `SC_DEFAULT_WMTR_PARAMS`: the engine defaults, a `scelo_wmtr_params`.
#' @export
SC_DEFAULT_WMTR_PARAMS <- sc_wmtr_params()

#' @param x A `scelo_wmtr_params` to print.
#' @param ... Ignored.
#' @rdname sc_wmtr_params
#' @export
print.scelo_wmtr_params <- function(x, ...) {
  cat(sprintf("WMTR parameters · %s shocks · %dy · %d paths · seed %s\n", x$shock, x$horizon, x$nPaths, format(x$seed)))
  vals <- vapply(.SC_WMTR_FIELDS, function(k) if (is.character(x[[k]])) x[[k]] else format(x[[k]]), character(1))
  cat(paste(sprintf("  %s = %s", .SC_WMTR_FIELDS, vals), collapse = "\n"), "\n")
  invisible(x)
}

.SC_ROW_ALIASES <- list(
  alphaM = c("alpha_m", "alpham"), alphaT = c("alpha_t", "alphat"), alphaR = c("alpha_r", "alphar"),
  wF = c("w_f", "wf"), wRel = c("w_rel", "wrel"), wS = c("w_s", "ws"),
  pProduction = c("p_production", "pproduction"), pFamily = c("p_family", "pfamily"), pReligion = c("p_religion", "preligion"),
  pSpatial = c("p_spatial", "pspatial"), pLeisure = c("p_leisure", "pleisure"),
  initFamily = c("init_family", "initfamily", "family_0"), initReligion = c("init_religion", "initreligion", "religion_0"),
  population = c("population", "pop", "n"), sqftPerResident = c("sqft_per_resident", "sqft_resident"),
  horizon = c("horizon", "horizon_years", "years"), nPaths = c("n_paths", "paths", "monte_carlo_paths"),
  shock = c("shock", "shock_severity", "severity"), seed = c("seed")
)

# Map override names (engine names, column names, any case) to engine names;
# the same lookup order as the Python port.
.sc_norm_overrides <- function(kw) {
  if (!length(kw)) return(list())
  if (is.null(names(kw)) || any(!nzchar(names(kw)))) stop("WMTR overrides must be named (e.g. shock = \"severe\")", call. = FALSE)
  fields <- stats::setNames(.SC_WMTR_FIELDS, tolower(.SC_WMTR_FIELDS))
  alias <- unlist(lapply(names(.SC_ROW_ALIASES), function(k) stats::setNames(rep(k, length(.SC_ROW_ALIASES[[k]])), .SC_ROW_ALIASES[[k]])))
  out <- list()
  for (k in names(kw)) {
    lk <- tolower(k)
    key <- fields[lk]
    if (is.na(key)) key <- alias[lk]
    if (is.na(key)) key <- fields[gsub("_", "", lk, fixed = TRUE)]
    if (is.na(key)) stop(sprintf("unknown WMTR parameter '%s'", k), call. = FALSE)
    v <- kw[[k]]
    out[[unname(key)]] <- if (key == "shock") tolower(as.character(v)) else v
  }
  out
}

# dataclasses.replace(): a copy of the parameters with some fields changed.
.sc_modify_params <- function(params, overrides) {
  ov <- .sc_norm_overrides(overrides)
  if (!length(ov)) return(params)
  p <- unclass(params)
  for (k in names(ov)) p[[k]] <- ov[[k]]
  do.call(sc_wmtr_params, p[.SC_WMTR_FIELDS])
}

.sc_as_wmtr_params <- function(x) {
  if (inherits(x, "scelo_wmtr_params")) return(x)
  if (is.list(x)) return(do.call(sc_wmtr_params, x[intersect(names(x), c(.SC_WMTR_FIELDS, "thresholds"))]))
  stop("params must be a scelo_wmtr_params (see sc_wmtr_params())", call. = FALSE)
}

# A scenario row (the wmtr-scenarios sample) → engine-named overrides.
.sc_config_from_row <- function(row) {
  cols <- stats::setNames(names(row), tolower(names(row)))
  out <- list()
  for (key in names(.SC_ROW_ALIASES)) {
    for (a in .SC_ROW_ALIASES[[key]]) {
      if (a %in% names(cols)) {
        v <- row[[cols[[a]]]]
        if (length(v) == 1 && !is.na(v)) {
          out[[key]] <- if (key == "shock") tolower(as.character(v)) else if (key %in% c("horizon", "nPaths", "seed")) as.integer(v) else as.numeric(v)
          break
        }
      }
    }
  }
  if (!is.null(out$shock) && !out$shock %in% names(SC_SHOCK_PARAMS)) out$shock <- NULL
  out
}

# ── the Monte Carlo ───────────────────────────────────────────────────────

#' Classify a wealth path
#'
#' Outcome of a wealth path: `collapsed` (below `collapse * w0` for
#' `recovery` consecutive years), `grew`, `declined` or `stabilized`.
#' @param w_hist Wealth by year, year 0 first.
#' @param w0 Initial wealth.
#' @param collapse,recovery,growth,stability Thresholds (see [sc_wmtr_params()]).
#' @return One of `"collapsed"`, `"grew"`, `"declined"`, `"stabilized"`.
#' @examples
#' sc_classify(c(1, 1.3), 1)
#' sc_classify(c(1, 1, 0.1, 0.1, 0.1, 0.1, 0.1, 1.5), 1)
#' @export
sc_classify <- function(w_hist, w0, collapse = 0.3, recovery = 5, growth = 0.2, stability = 0.1) {
  below <- w_hist < collapse * w0
  if (any(below)) {
    r <- rle(below)
    if (any(r$values & r$lengths >= recovery)) return("collapsed")
  }
  wT <- w_hist[length(w_hist)]
  if (wT > w0 * (1 + growth)) return("grew")
  if (wT < w0 * (1 - stability)) return("declined")
  "stabilized"
}

.sc_normalize_five <- function(p) {
  total <- sum(p)
  if (total > 0) p / total else rep(0.2, 5)
}

.sc_run_one_path <- function(p, nxt) {
  dt <- 1
  five <- .sc_normalize_five(c(p$pProduction, p$pFamily, p$pReligion, p$pSpatial, p$pLeisure))
  pProd <- five[1]; pFam <- five[2]; pRel <- five[3]; pSp <- five[4]; pLeis <- five[5]
  a_sum <- p$alphaM + p$alphaT + p$alphaR
  if (a_sum == 0) a_sum <- 1
  aM <- p$alphaM / a_sum; aT <- p$alphaT / a_sum; aR <- p$alphaR / a_sum
  M <- 1
  family <- .sc_clamp(p$initFamily, 0, 1)
  religion <- .sc_clamp(p$initReligion, 0, 1)
  sqft <- p$sqftPerResident
  wF <- p$wF; wRel <- p$wRel; wS <- p$wS
  shock_env <- p$shock
  Teff0 <- pProd + 0.3 * pLeis
  R0 <- .sc_compute_r(family, religion, sqft, wF, wRel, wS)
  W0 <- .sc_compute_w(M, Teff0, R0, aM, aT, aR)
  H <- p$horizon
  w_hist <- numeric(H + 1); m_hist <- numeric(H + 1); t_hist <- numeric(H + 1); r_hist <- numeric(H + 1); surv <- numeric(H + 1)
  w_hist[1] <- W0; m_hist[1] <- M; t_hist[1] <- Teff0; r_hist[1] <- R0; surv[1] <- 1
  cum_haz <- 0
  cooldown <- 0
  for (yr in seq_len(H)) {
    m_growth <- 0.04 * pProd * M * dt
    m_drain <- 0.01 * M * dt
    M <- max(M + m_growth - m_drain, 1e-6)
    mc_severity <- 0
    if (cooldown <= 0) {
      sh <- .sc_single_shocks(nxt, shock_env)
      if (!is.null(sh)) {
        for (i in seq_along(sh$sev)) {
          target <- sh$targets[i]
          sev <- sh$sev[i]
          if (target == "material" || target == "combined") M <- max(M * (1 - sev), 1e-6)
          if (target == "time" || target == "combined") {
            red <- pProd * sev * 0.5
            pProd <- max(pProd - red, 0.01)
            pSp <- pSp + red * 0.5
          }
          if (target == "family") family <- max(family * (1 - sev), 0)
          if (target == "religion") religion <- max(religion * (1 - sev), 0)
          if (target == "meaning_crisis") mc_severity <- max(mc_severity, sev)
        }
        cooldown <- 0.5
      }
    } else {
      cooldown <- cooldown - dt
    }
    family <- if (pFam >= 0.1) .sc_clamp(family + 0.1 * pFam * dt, 0, 1) else .sc_clamp(family - 0.05 * dt, 0, 1)
    eff_rel <- pRel * (1 + religion * 0.2)
    religion <- if (pRel >= 0.05) .sc_clamp(religion + 0.08 * eff_rel * dt, 0, 1) else .sc_clamp(religion - 0.03 * dt, 0, 1)
    if (mc_severity > 0) religion <- .sc_clamp(religion - mc_severity * religion * 0.1 * dt, 0, 1)
    Teff <- pProd + 0.3 * pLeis
    R <- .sc_compute_r(family, religion, sqft, wF, wRel, wS)
    W <- .sc_compute_w(M, Teff, R, aM, aT, aR)
    h <- .SC_H0 * exp(-.SC_BETA_W * log(max(W / W0, 1e-6)))
    cum_haz <- cum_haz + h * dt
    surv[yr + 1] <- exp(-cum_haz)
    w_hist[yr + 1] <- W
    m_hist[yr + 1] <- M
    t_hist[yr + 1] <- Teff
    r_hist[yr + 1] <- R
  }
  list(w = w_hist, m = m_hist, t = t_hist, r = r_hist, surv = surv,
       outcome = sc_classify(w_hist, W0, p$collapse, p$recovery, p$growth, p$stability))
}

# The engine's percentile: sorted[clamp(floor(pct/100 * (n - 1)), 0, n - 1)] (0-based).
.sc_wmtr_percentile <- function(sorted_col, pct) {
  n <- length(sorted_col)
  idx <- .sc_clamp(floor((pct / 100) * (n - 1)), 0, n - 1)
  sorted_col[idx + 1]
}

#' Run the WMTR Monte Carlo
#'
#' Run the forecast for explicit parameters (see [sc_wmtr()] for the
#' convenient form). The result holds the paths, the year-by-year table,
#' the outcome fractions, the dominant outcome and the driver decomposition.
#' @param params A `scelo_wmtr_params` (or a plain list of the same fields).
#' @return A list of class `scelo_wmtr`: `params`, `paths` (one list per
#'   path with `w`, `m`, `t`, `r`, `surv`, `outcome`), `table` (a
#'   `scelo_table`: `year`, `mean_W`, `p10_W`, `p25_W`, `p75_W`, `p90_W`,
#'   `survival`, `mean_M`, `mean_T`, `mean_R`), `outcome_fractions`,
#'   `dominant`, `w0`, `drivers`, `survival` (at the horizon).
#' @examples
#' r <- sc_run_wmtr(sc_wmtr_params(nPaths = 20, horizon = 10))
#' r$outcome_fractions
#' @export
sc_run_wmtr <- function(params) {
  params <- .sc_as_wmtr_params(params)
  if (!params$shock %in% names(SC_SHOCK_PARAMS)) stop(sprintf("shock must be one of %s (got '%s')", paste(names(SC_SHOCK_PARAMS), collapse = ", "), params$shock), call. = FALSE)
  if (is.na(params$nPaths) || params$nPaths < 1L) stop("nPaths must be at least 1", call. = FALSE)
  if (is.na(params$horizon) || params$horizon < 1L) stop("horizon must be at least 1 year", call. = FALSE)
  rand <- sc_mulberry32(params$seed)
  nxt <- .sc_rng_buffer(rand)
  paths <- vector("list", params$nPaths)
  for (i in seq_len(params$nPaths)) paths[[i]] <- .sc_run_one_path(params, nxt)
  T <- params$horizon + 1L
  agg <- function(key, how) {
    m <- vapply(paths, function(pth) pth[[key]], numeric(T)) # T x nPaths
    if (is.null(dim(m))) m <- matrix(m, nrow = T)
    if (identical(how, "mean")) return(rowMeans(m))
    apply(m, 1, function(col) .sc_wmtr_percentile(sort(col), how))
  }
  outcomes <- vapply(paths, function(pth) pth$outcome, character(1))
  kinds <- c("grew", "stabilized", "declined", "collapsed")
  counts <- vapply(kinds, function(k) sum(outcomes == k), numeric(1))
  fracs <- as.list(counts / max(length(paths), 1))
  dominant <- kinds[which.max(unlist(fracs))]
  w0 <- paths[[1]]$w[1]
  table <- data.frame(year = seq_len(T) - 1L, mean_W = agg("w", "mean"), p10_W = agg("w", 10), p25_W = agg("w", 25), p75_W = agg("w", 75),
                      p90_W = agg("w", 90), survival = agg("surv", "mean"), mean_M = agg("m", "mean"), mean_T = agg("t", "mean"), mean_R = agg("r", "mean"))
  res <- structure(list(params = params, paths = paths, table = NULL, outcome_fractions = fracs, dominant = dominant, w0 = w0, drivers = NULL,
                        survival = table$survival[T]), class = c("scelo_wmtr", "list"))
  d <- sc_driver_contributions(res)
  res$drivers <- d
  driver <- sc_dominant_driver(res)
  p <- params
  notes <- c(
    sprintf("Outcomes: grew %.0f%% · stabilized %.0f%% · declined %.0f%% · collapsed %.0f%% (dominant: %s). Mean survival at horizon %.3f; W/W₀ %.2f.",
            100 * fracs$grew, 100 * fracs$stabilized, 100 * fracs$declined, 100 * fracs$collapsed, dominant, res$survival, table$mean_W[T] / w0),
    sprintf("Drivers (Σ = mean Δln W = %+.4f): M %+.4f · T %+.4f · R %+.4f; dominant %s. Exact Cobb-Douglas decomposition, accumulated per path then averaged.",
            d$net, d$M, d$T, d$R, driver),
    "W = M^αM·T^αT·R^αR; hazard h = 0.02·(W/W₀)^−2; shocks ~ Poisson(λ) with Normal severities clipped to (0.01, 0.9). Same Mulberry32 stream as Scelo IDE / the swarm for this seed."
  )
  t <- sc_table(table, title = sprintf("WMTR forecast · %s shocks · %dy · %d paths · seed %s", p$shock, p$horizon, p$nPaths, format(p$seed)),
                basis = sprintf("α = (%g, %g, %g) · w = (%g, %g, %g) · shock %s", p$alphaM, p$alphaT, p$alphaR, p$wF, p$wRel, p$wS, p$shock),
                notes = notes, stage = "hard")
  attr(t, "outcome_fractions") <- fracs
  attr(t, "dominant") <- dominant
  attr(t, "drivers") <- d
  attr(t, "w0") <- w0
  res$table <- t
  res
}

#' @param x A `scelo_wmtr` to print.
#' @param ... Passed to the table's print method.
#' @rdname sc_run_wmtr
#' @export
print.scelo_wmtr <- function(x, ...) {
  p <- x$params
  n <- nrow(x$table)
  cat(sprintf("WMTR · %s · %dy · %d paths · survival@horizon %.3f · W/W₀ %.2f · dominant %s · driver %s\n",
              p$shock, p$horizon, p$nPaths, x$survival, x$table$mean_W[n] / x$w0, x$dominant, sc_dominant_driver(x)))
  print(x$table, ...)
  invisible(x)
}

#' Driver decomposition of a WMTR result
#'
#' Exact decomposition ln W_T - ln W_0 = aM * dln M + aT * dln T + aR * dln R,
#' averaged over paths; `sc_dominant_driver()` names the largest in
#' absolute value.
#' @param r A `scelo_wmtr` result.
#' @param up_to Year to decompose to (the horizon by default).
#' @return A list `M`, `T`, `R`, `net` (`sc_driver_contributions`) or one of
#'   `"M"`, `"T"`, `"R"` (`sc_dominant_driver`).
#' @examples
#' r <- sc_run_wmtr(sc_wmtr_params(nPaths = 20, horizon = 10))
#' sc_driver_contributions(r)
#' sc_dominant_driver(r)
#' @export
sc_driver_contributions <- function(r, up_to = NULL) {
  p <- r$params
  a_sum <- p$alphaM + p$alphaT + p$alphaR
  if (a_sum == 0) a_sum <- 1
  aM <- p$alphaM / a_sum; aT <- p$alphaT / a_sum; aR <- p$alphaR / a_sum
  last <- .sc_clamp(floor(if (is.null(up_to)) p$horizon else up_to), 0, p$horizon)
  ln <- function(x) log(pmax(x, 1e-9))
  pick <- function(key, i) vapply(r$paths, function(pth) pth[[key]][i], numeric(1))
  n <- max(length(r$paths), 1)
  list(M = sum(aM * (ln(pick("m", last + 1)) - ln(pick("m", 1)))) / n,
       T = sum(aT * (ln(pick("t", last + 1)) - ln(pick("t", 1)))) / n,
       R = sum(aR * (ln(pick("r", last + 1)) - ln(pick("r", 1)))) / n,
       net = sum(ln(pick("w", last + 1)) - ln(pick("w", 1))) / n)
}

#' @rdname sc_driver_contributions
#' @export
sc_dominant_driver <- function(r) {
  c <- sc_driver_contributions(r)
  c("M", "T", "R")[which.max(abs(c(c$M, c$T, c$R)))]
}

# ── scenario → config (apps/web forecast/derive.ts) ──────────────────────

.sc_cue_regex <- function(cue) {
  stem <- endsWith(cue, "*")
  body <- if (stem) substr(cue, 1, nchar(cue) - 1) else cue
  body <- gsub("([][{}()+*^$|\\\\?.-])", "\\\\\\1", body)
  if (stem) paste0("\\b", body) else paste0("\\b", body, "s?\\b")
}

# Word-bounded cue matching: "war" must not read "software"; a trailing "*"
# matches any continuation (stem); underscores count as spaces.
.sc_kw <- function(text, cues) {
  t <- gsub("_", " ", text, fixed = TRUE)
  for (c in cues) if (grepl(.sc_cue_regex(c), t, ignore.case = TRUE, perl = TRUE)) return(TRUE)
  FALSE
}

# JavaScript strings are UTF-16: code points above the BMP hash as two units.
.sc_utf16_units <- function(s) {
  cp <- utf8ToInt(enc2utf8(as.character(s)))
  if (!length(cp) || all(cp <= 65535)) return(cp)
  out <- integer()
  for (c in cp) {
    if (c > 65535) {
      v <- c - 65536
      out <- c(out, 55296 + v %/% 1024, 56320 + v %% 1024)
    } else {
      out <- c(out, c)
    }
  }
  out
}

# The IDE's scenario hash: FNV-1a as JavaScript evaluates it. `h ^ c` is a
# signed int32, the multiply happens in double precision (rounded to the
# nearest double, as V8 does) and `>>> 0` reduces modulo 2^32.
.sc_fnv1a <- function(s) {
  h <- 2166136261
  for (c in .sc_utf16_units(s)) {
    x <- .sc_xor32(h, c)
    if (x >= 2147483648) x <- x - .SC_2POW32
    h <- (x * 16777619) %% .SC_2POW32
  }
  h
}

#' Derive WMTR parameters from scenario text
#'
#' The IDE's forecast-family heuristic: shock severity, domain alpha
#' presets, horizon and a scenario-specific seed from the text (word-bounded
#' cue matching; FNV-1a hash modulo 9999 for the seed).
#' @param scenario Free text describing the entity and its situation.
#' @param ... Parameter overrides by engine name (`alphaM`) or column name (`alpha_m`).
#' @return A `scelo_wmtr_params`.
#' @examples
#' sc_derive_config("rural village facing a severe drought")
#' @export
sc_derive_config <- function(scenario, ...) {
  base <- sc_wmtr_params()
  if (.sc_kw(scenario, c("catastroph*", "war", "warfare", "pandemic", "famine", "collapse*", "severe", "crisis", "crises", "depression", "shock", "downgrade", "cliff"))) {
    base$shock <- "severe"
  } else if (.sc_kw(scenario, c("mild", "calm", "stable", "benign", "orderly", "normal"))) {
    base$shock <- "mild"
  } else {
    base$shock <- "moderate"
  }
  if (.sc_kw(scenario, c("pension", "scheme", "sponsor", "covenant", "db plan", "annuity book"))) {
    base$alphaM <- 0.35; base$alphaT <- 0.25; base$alphaR <- 0.40
  } else if (.sc_kw(scenario, c("life book", "life insurance", "term life", "ifrs 17", "csm", "solvency ii"))) {
    base$alphaM <- 0.50; base$alphaT <- 0.20; base$alphaR <- 0.30
  } else if (.sc_kw(scenario, c("reserv*", "ibnr", "triangle", "chain ladder", "bornhuetter"))) {
    base$alphaM <- 0.55; base$alphaT <- 0.30; base$alphaR <- 0.15
  } else if (.sc_kw(scenario, c("rural", "village", "subsistence", "agrarian", "farming"))) {
    base$alphaM <- 0.30; base$alphaT <- 0.30; base$alphaR <- 0.40
    base$wF <- 0.50; base$wRel <- 0.30; base$wS <- 0.20
    base$sqftPerResident <- 800
  } else if (.sc_kw(scenario, c("urban", "city", "cities", "metropol*", "downtown"))) {
    base$alphaM <- 0.50; base$alphaT <- 0.30; base$alphaR <- 0.20
    base$sqftPerResident <- 220
  }
  if (.sc_kw(scenario, c("century", "long-term", "multi-generational"))) {
    base$horizon <- 60L
  } else if (.sc_kw(scenario, c("next year", "short term", "immediate"))) {
    base$horizon <- 10L
  }
  base$seed <- .sc_fnv1a(scenario) %% 9999
  base$nPaths <- 200L
  .sc_modify_params(base, list(...))
}

# ── the convenient form ───────────────────────────────────────────────────

#' WMTR survival forecast
#'
#' Forecast an entity's survival: `sc_wmtr("pension scheme, sponsor covenant
#' weakening")`, `sc_wmtr(df)` (a scenario row, e.g. from
#' `sc_sample("wmtr-scenarios")`), `sc_wmtr(shock = "severe", horizon = 50)`.
#'
#' Returns a result whose table is the year-by-year mean / p10 / p25 / p75 /
#' p90 wealth, survival and the M, T, R means; outcome fractions, the
#' dominant outcome and the driver decomposition sit in the notes, in the
#' result and as attributes of the table. Parameters may be given by engine
#' name (`alphaM`) or column name (`alpha_m`).
#' @param scenario Scenario text, a data frame (first row read as a scenario
#'   row), a named list (one row), a `scelo_wmtr_params`, or `NULL` (the
#'   defaults plus `...`).
#' @param ... Parameter overrides (see [sc_wmtr_params()]).
#' @return A `scelo_wmtr` (see [sc_run_wmtr()]).
#' @examples
#' r <- sc_wmtr("rural village facing a severe drought", nPaths = 20)
#' r$dominant
#' sc_wmtr(sc_sample("wmtr-scenarios"), nPaths = 10)$params$shock
#' @export
sc_wmtr <- function(scenario = NULL, ...) {
  overrides <- list(...)
  input <- if (is.data.frame(scenario)) scenario else NULL
  .sc_tool("sc_wmtr", c(list(scenario = scenario), overrides), input, {
    params <- if (inherits(scenario, "scelo_wmtr_params")) {
      .sc_modify_params(scenario, overrides)
    } else if (is.character(scenario)) {
      sc_derive_config(scenario, ...)
    } else if (is.data.frame(scenario) || (is.list(scenario) && !is.null(names(scenario)))) {
      row <- if (is.data.frame(scenario)) scenario[1, , drop = FALSE] else scenario
      cfg <- .sc_config_from_row(row)
      ov <- .sc_norm_overrides(overrides)
      for (k in names(ov)) cfg[[k]] <- ov[[k]]
      .sc_modify_params(sc_wmtr_params(), cfg)
    } else if (is.null(scenario)) {
      .sc_modify_params(sc_wmtr_params(), overrides)
    } else {
      stop("scenario must be text, a data frame / row, a scelo_wmtr_params or NULL", call. = FALSE)
    }
    sc_run_wmtr(params)
  })
}

#' Apply a council intervention to WMTR parameters
#'
#' Shift one parameter by 0.07 (`small`) or 0.20 (`large`) within `[0, 1]`,
#' or step the shock environment one level up or down.
#' @param params A `scelo_wmtr_params`.
#' @param param One of [SC_INTERVENTION_PARAMS].
#' @param direction `"increase"` or `"decrease"`.
#' @param magnitude `"small"` or `"large"`.
#' @return The modified `scelo_wmtr_params`.
#' @examples
#' sc_apply_intervention(sc_wmtr_params(), "pFamily", "increase", "large")$pFamily
#' @export
sc_apply_intervention <- function(params, param, direction = "increase", magnitude = "small") {
  if (!param %in% SC_INTERVENTION_PARAMS) stop(sprintf("param must be one of %s", paste(SC_INTERVENTION_PARAMS, collapse = ", ")), call. = FALSE)
  params <- .sc_as_wmtr_params(params)
  nxt <- params
  if (param == "shock") {
    order <- c("mild", "moderate", "severe")
    idx <- match(params$shock, order)
    if (is.na(idx)) stop(sprintf("shock must be one of %s (got '%s')", paste(order, collapse = ", "), params$shock), call. = FALSE)
    nxt$shock <- order[max(1, min(3, idx + (if (direction == "increase") 1 else -1)))]
    return(nxt)
  }
  step <- if (magnitude == "small") 0.07 else 0.20
  sign <- if (direction == "increase") 1 else -1
  nxt[[param]] <- max(0, min(1, params[[param]] + sign * step))
  nxt
}

#' Shock sensitivity of a WMTR forecast
#'
#' The same forecast under mild / moderate / severe shocks, outcome mix and
#' survival side by side.
#' @param scenario Scenario text, a `scelo_wmtr_params`, or `NULL` (defaults plus `...`).
#' @param ... Parameter overrides.
#' @return A `scelo_table` with `shock`, `grew`, `stabilized`, `declined`,
#'   `collapsed`, `survival`, `W/W0`.
#' @examples
#' sc_sensitivity(nPaths = 20, horizon = 10)
#' @export
sc_sensitivity <- function(scenario = NULL, ...) {
  overrides <- list(...)
  .sc_tool("sc_sensitivity", c(list(scenario = scenario), overrides), NULL, {
    base <- if (inherits(scenario, "scelo_wmtr_params")) scenario else if (is.character(scenario)) sc_derive_config(scenario, ...) else .sc_modify_params(sc_wmtr_params(), overrides)
    rows <- lapply(c("mild", "moderate", "severe"), function(env) {
      r <- sc_run_wmtr(.sc_modify_params(base, list(shock = env)))
      f <- r$outcome_fractions
      data.frame(shock = env, grew = f$grew, stabilized = f$stabilized, declined = f$declined, collapsed = f$collapsed, survival = r$survival,
                 `W/W0` = r$table$mean_W[nrow(r$table)] / r$w0, check.names = FALSE, stringsAsFactors = FALSE)
    })
    out <- do.call(rbind, rows)
    delta <- out$collapsed[3] - out$collapsed[1]
    sc_table(out, title = "WMTR shock sensitivity", basis = sprintf("horizon %dy · %d paths · seed %s", base$horizon, base$nPaths, format(base$seed)), stage = "hard",
             notes = sprintf("Collapse-Δ (severe − mild) = %+.1f%%: the share of paths that collapse depends on the shock environment by this much.", 100 * delta))
  })
}
