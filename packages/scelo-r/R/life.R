# Life: mortality bases, life tables, commutation functions, factors, premiums.
#
# The table generators follow packages/scelo-core/src/actuarialTables.ts
# line for line (the IDE's "build a life table at 4 %" chat command), so a
# table built here is the table the IDE builds, and the same numbers the
# Python package (scelo.life) produces. Beyond those: Whittaker-Henderson
# graduation, Lee-Carter (SVD, random-walk-with-drift forecast),
# Kaplan-Meier, policy-year exposure, and a port of lifelib's BasicTerm_ME
# monthly projection with Scelo's illustrative assumptions.
#
# A mortality basis is any of:
#   * a data frame with age + qx (or age + lx, or age + deaths + exposure),
#   * a named numeric vector of qx by age,
#   * list(A = , B = , c = ) or the string "makeham" (Scelo's illustrative
#     Gompertz-Makeham, always labelled as illustrative),
#   * a scelo_qx object from sc_qx().
#
# Keyword-only arguments in the Python signatures (after `*`) sit after `...`
# here, so `sc_life_table(df, age = "Age")` reaches sc_qx() instead of being
# partially matched to `ages`.

#' Scelo's illustrative Gompertz-Makeham parameters
#'
#' `A = 0.00022, B = 2.7e-6, c = 1.124`: the basis every life function uses
#' when none is given. It is illustrative, not a published standard table,
#' and every table built on it says so in its notes.
#' @format A named list with `A`, `B`, `c`.
#' @export
SC_ILLUSTRATIVE_MAKEHAM <- list(A = 0.00022, B = 2.7e-6, c = 1.124)

# ── small formatting helpers (Python f-string equivalents) ────────────────

.sc_pct <- function(i) sprintf("%g %%", round(i * 100, 2))
.sc_comma <- function(x) formatC(x, format = "f", digits = 0, big.mark = ",")
.sc_int_comma <- function(n) formatC(as.numeric(n), format = "f", digits = 0, big.mark = ",")
.sc_g <- function(x) sprintf("%g", x)
# Python's repr() of a float: "0.0", "1.124", "0.0003", "2.7e-06" (scientific below 1e-4).
.sc_repr <- function(x) {
  x <- as.numeric(x)
  if (is.na(x)) return("nan")
  if (x == round(x) && abs(x) < 1e16) return(sprintf("%.1f", x))
  if (abs(x) >= 1e-4 && abs(x) < 1e16) return(format(x, scientific = FALSE, digits = 15))
  as.character(x)
}
.sc_args <- function(...) Filter(Negate(is.null), list(...))

# pandas.to_numeric(errors = "coerce"): numbers stay, numeric strings become numbers, the rest NA.
.sc_to_num <- function(v) {
  if (is.numeric(v)) return(as.numeric(v))
  if (is.logical(v)) return(as.numeric(v))
  if (is.factor(v)) v <- as.character(v)
  suppressWarnings(as.numeric(trimws(as.character(v))))
}

# ── mortality laws ──────────────────────────────────────────────────────────

#' Gompertz-Makeham mortality rates
#'
#' `sc_makeham()` gives qx from the force of mortality mu(x) = A + B c^x,
#' integrated over the year of age: qx = 1 - exp(-(A + B c^x (c - 1) / ln c) m),
#' clipped to \[0, 1\]. `sc_gompertz()` is Makeham with A = 0.
#'
#' @param ages Ages (numeric vector).
#' @param A,B,c Makeham parameters; default Scelo's illustrative
#'   [SC_ILLUSTRATIVE_MAKEHAM].
#' @param multiplier Scales the integrated hazard (1 = no change).
#' @return A named numeric vector of qx, names the ages.
#' @examples
#' sc_makeham(60:65)
#' sc_gompertz(60:65)
#' @export
sc_makeham <- function(ages, A = SC_ILLUSTRATIVE_MAKEHAM$A, B = SC_ILLUSTRATIVE_MAKEHAM$B, c = SC_ILLUSTRATIVE_MAKEHAM$c, multiplier = 1) {
  x <- as.numeric(ages)
  integral <- A + (B * c^x * (c - 1)) / base::log(c)
  q <- 1 - exp(-integral * multiplier)
  stats::setNames(pmin(pmax(q, 0), 1), as.character(x))
}

#' @rdname sc_makeham
#' @export
sc_gompertz <- function(ages, B = SC_ILLUSTRATIVE_MAKEHAM$B, c = SC_ILLUSTRATIVE_MAKEHAM$c) sc_makeham(ages, 0, B, c)

# ── basis → qx by age ───────────────────────────────────────────────────────

.sc_qx_table <- function(ages, qx, label, notes) {
  structure(list(ages = as.integer(ages), qx = as.numeric(qx), label = label, notes = as.character(notes)), class = c("scelo_qx", "list"))
}

# Interpolate linearly across the missing ages between the first and last known age.
.sc_fill_gaps <- function(by_age) {
  ks <- as.integer(names(by_age))
  o <- order(ks)
  ks <- ks[o]
  vals_known <- as.numeric(by_age)[o]
  ages <- seq.int(ks[1], ks[length(ks)])
  vals <- if (length(ks) == 1) vals_known else stats::approx(ks, vals_known, xout = ages)$y
  list(ages = ages, vals = vals, filled = length(ages) - length(ks))
}

.sc_ages_arg <- function(ages) {
  if (is.null(ages)) return(NULL)
  if (is.list(ages)) ages <- unlist(lapply(ages, function(v) if (is.null(v)) NA else v))
  if (!is.numeric(ages) && !all(is.na(ages))) stop("ages must be c(from, to)", call. = FALSE)
  if (length(ages) == 2) return(c(if (is.na(ages[1])) NA_integer_ else as.integer(ages[1]), if (is.na(ages[2])) NA_integer_ else as.integer(ages[2])))
  if (length(ages) > 2) return(c(as.integer(ages[1]), as.integer(ages[length(ages)])))
  stop("ages must be c(from, to)", call. = FALSE)
}

#' Resolve any mortality basis to an annual (age, qx) table
#'
#' `sc_qx()` gives Scelo's illustrative Makeham from 20 to 110; `sc_qx(df)`
#' finds age + qx / lx / deaths + exposure columns; `sc_qx(q)` with a named
#' numeric vector takes qx by age; `sc_qx(list(A = , B = , c = ))` a custom
#' Makeham; `"gompertz"` the illustrative parameters with A = 0. Gaps in an
#' age range are interpolated linearly; percent-shaped qx (> 1) is divided
#' by 100; crude deaths / exposure rates are flagged as ungraduated.
#'
#' @param basis `NULL`, `"makeham"`, `"gompertz"`, a list of Makeham
#'   parameters, a data frame, a named numeric vector of qx by age, or a
#'   `scelo_qx` (returned as is).
#' @param df A data frame with an age column and qx / lx / deaths + exposure
#'   columns (when `basis` is not itself the frame).
#' @param ... Makeham overrides `A`, `B`, `c`, `multiplier`.
#' @param ages `c(from, to)` to restrict the ages (`NA` for an open end).
#' @param age,qx_col,lx,deaths,exposure_col Column names, inferred when
#'   `NULL`.
#' @return A `scelo_qx`: a list with `ages` (integer), `qx`, `label` and
#'   `notes`; `as.data.frame()` gives the (age, qx) frame.
#' @examples
#' q <- sc_qx()
#' q$label
#' sc_qx(data.frame(age = c(30, 31, 33), qx = c(1.1, 1.3, 1.5)))  # percent, with a gap
#' @export
sc_qx <- function(basis = NULL, df = NULL, ..., ages = NULL, age = NULL, qx_col = NULL, lx = NULL, deaths = NULL, exposure_col = NULL) {
  notes <- character()
  if (inherits(basis, "scelo_qx")) return(basis)
  if (is.data.frame(basis) && is.null(df)) {
    df <- basis
    basis <- NULL
  }
  if (is.null(basis) && is.null(df)) basis <- "makeham"
  ages <- .sc_ages_arg(ages)
  kw <- list(...)
  is_string <- is.character(basis) && length(basis) == 1
  is_law <- (is_string && tolower(basis) %in% c("makeham", "illustrative", "gompertz-makeham", "gompertz")) || (is.list(basis) && !is.data.frame(basis))
  if (is_law) {
    p <- SC_ILLUSTRATIVE_MAKEHAM
    if (is.list(basis)) for (k in intersect(names(basis), c("A", "B", "c", "multiplier"))) p[[k]] <- as.numeric(basis[[k]])
    for (k in intersect(names(kw), c("A", "B", "c", "multiplier"))) p[[k]] <- as.numeric(kw[[k]])
    if (is_string && tolower(basis) == "gompertz") p$A <- 0
    lo <- if (!is.null(ages) && !is.na(ages[1])) ages[1] else 20L
    hi <- if (!is.null(ages) && !is.na(ages[2])) ages[2] else 110L
    if (hi < lo) stop("no ages left inside the requested range", call. = FALSE)
    ax <- seq.int(lo, hi)
    mult <- if (is.null(p$multiplier)) 1 else p$multiplier
    q <- unname(sc_makeham(ax, p$A, p$B, p$c, mult))
    illustrative <- p$A == SC_ILLUSTRATIVE_MAKEHAM$A && p$B == SC_ILLUSTRATIVE_MAKEHAM$B && p$c == SC_ILLUSTRATIVE_MAKEHAM$c
    notes <- c(notes, if (illustrative) {
      "Mortality is Scelo's ILLUSTRATIVE Gompertz–Makeham basis (A = 0.00022, B = 2.7e-6, c = 1.124), not a published standard table: swap in your own qx column or parameters before relying on the figures."
    } else {
      paste0(sprintf("Mortality from Gompertz–Makeham μx = A + B·cˣ with A = %s, B = %s, c = %s", .sc_repr(p$A), .sc_repr(p$B), .sc_repr(p$c)),
             if (mult != 1) sprintf(", × %s", .sc_repr(mult)) else "", ".")
    })
    return(.sc_qx_table(ax, q, if (illustrative) "Gompertz–Makeham (illustrative)" else "Gompertz–Makeham (custom)", notes))
  }
  if (is.numeric(basis)) {
    v <- as.numeric(basis)
    ks <- if (is.null(names(basis))) seq_along(v) - 1 else suppressWarnings(as.numeric(names(basis)))
    keep <- !is.na(v) & !is.na(ks)
    by_age <- stats::setNames(v[keep], as.integer(round(ks[keep])))
    by_age <- by_age[!duplicated(names(by_age), fromLast = TRUE)]
    label <- "qx from `qx` by age"
  } else if (!is.null(basis)) {
    stop(sprintf("unknown mortality basis '%s': use \"makeham\", \"gompertz\", list(A = , B = , c = ), a data frame with age + qx, or a named qx vector", paste(format(basis), collapse = ", ")), call. = FALSE)
  } else {
    a <- sc_infer(df, "age", age)
    have_q <- if (!is.null(qx_col)) sc_infer(df, "qx", qx_col) else if (is.null(lx) && is.null(deaths)) sc_infer(df, "qx", NULL, required = FALSE, exclude = a) else NULL
    have_l <- if (!is.null(lx)) sc_infer(df, "lx", lx) else if (is.null(have_q) && is.null(deaths)) sc_infer(df, "lx", NULL, required = FALSE, exclude = a) else NULL
    ages_s <- round(.sc_to_num(df[[a]]))
    if (!is.null(have_q)) {
      v <- .sc_to_num(df[[have_q]])
      ok <- !is.na(ages_s) & !is.na(v)
      g <- tapply(v[ok], ages_s[ok], mean)
      if (length(g) && max(g) > 1) {
        notes <- c(notes, sprintf("`%s` looked like percentages (max %.3f): divided by 100.", have_q, max(g)))
        g <- g / 100
      }
      by_age <- stats::setNames(as.numeric(g), as.integer(names(g)))
      label <- sprintf("qx from `%s` by `%s`", have_q, a)
    } else if (!is.null(have_l)) {
      v <- .sc_to_num(df[[have_l]])
      ok <- !is.na(ages_s) & !is.na(v)
      g <- tapply(v[ok], ages_s[ok], mean)
      ks <- as.integer(names(g))
      l <- as.numeric(g)
      m <- length(ks)
      idx <- if (m > 1) which(ks[-1] == ks[-m] + 1L & l[-m] > 0) else integer()
      by_age <- stats::setNames(pmin(1, pmax(0, 1 - l[idx + 1] / l[idx])), ks[idx])
      label <- sprintf("qx derived from `%s` by `%s`", have_l, a)
      notes <- c(notes, "qx = 1 − l(x+1)/l(x) from the survivor column; the last age has no successor and is closed with qx = 1.")
    } else {
      d <- sc_infer(df, "deaths", deaths, exclude = a)
      e <- sc_infer(df, "exposure", exposure_col, exclude = c(a, d))
      dv <- .sc_to_num(df[[d]])
      ev <- .sc_to_num(df[[e]])
      ok <- !is.na(ages_s) & !is.na(dv) & !is.na(ev)
      g <- rowsum(cbind(d = dv[ok], e = ev[ok]), ages_s[ok])
      g <- g[g[, "e"] > 0, , drop = FALSE]
      by_age <- stats::setNames(pmin(1, pmax(0, g[, "d"] / g[, "e"])), as.integer(rownames(g)))
      label <- sprintf("crude qx = `%s` / `%s` by `%s`", d, e, a)
      notes <- c(notes, "Crude rates (deaths ÷ exposure), ungraduated. Graduate before using for pricing or reserving (sc_graduate).")
    }
  }
  if (!length(by_age)) stop("no usable (age, rate) pairs: check the columns are numeric", call. = FALSE)
  f <- .sc_fill_gaps(by_age)
  ax <- f$ages
  q <- f$vals
  if (f$filled) notes <- c(notes, sprintf("%d missing age%s interpolated linearly.", f$filled, if (f$filled != 1) "s" else ""))
  if (!is.null(ages)) {
    lo <- if (is.na(ages[1])) -Inf else ages[1]
    hi <- if (is.na(ages[2])) Inf else ages[2]
    keep <- ax >= lo & ax <= hi
    ax <- ax[keep]
    q <- q[keep]
    if (!length(ax)) stop("no ages left inside the requested range", call. = FALSE)
  }
  .sc_qx_table(ax, q, label, notes)
}

#' @export
as.data.frame.scelo_qx <- function(x, ...) data.frame(age = x$ages, qx = x$qx)

#' @export
print.scelo_qx <- function(x, ...) {
  cat(sprintf("qx · %s · ages %d–%d (%d rates)\n", x$label, x$ages[1], x$ages[length(x$ages)], length(x$ages)))
  for (n in x$notes) cat("  · ", n, "\n", sep = "")
  invisible(x)
}

# ── life table core ─────────────────────────────────────────────────────────

.sc_life_cols <- function(q, radix) {
  qx_ <- as.numeric(q$qx)
  n <- length(qx_)
  qx_[n] <- 1  # close the table
  px <- 1 - qx_
  lx <- radix * c(1, cumprod(px[-n]))
  dx <- lx * qx_
  Lx <- lx - dx / 2
  Tx <- rev(cumsum(rev(Lx)))
  ex <- ifelse(lx > 0, Tx / ifelse(lx > 0, lx, 1), 0)
  list(age = q$ages, qx = qx_, px = px, lx = lx, dx = dx, Lx = Lx, Tx = Tx, ex = ex)
}

.sc_commutation <- function(L, i) {
  v <- 1 / (1 + i)
  ages <- L$age
  vx <- v^(ages - ages[1])
  Dx <- vx * L$lx
  Cx <- vx * v * L$dx
  Nx <- rev(cumsum(rev(Dx)))
  Mx <- rev(cumsum(rev(Cx)))
  Rx <- rev(cumsum(rev(Mx)))
  Sx <- rev(cumsum(rev(Nx)))
  list(v = v, vx = vx, Dx = Dx, Cx = Cx, Nx = Nx, Mx = Mx, Rx = Rx, Sx = Sx)
}

.sc_basis_input <- function(basis, df) if (is.data.frame(df)) df else if (is.data.frame(basis)) basis else NULL

#' Life table
#'
#' Age, qx, px, lx, dx, Lx, Tx, ex. `sc_life_table()` uses the illustrative
#' Makeham basis; `sc_life_table(df)` your qx. The last age carries qx = 1
#' so Tx / ex are finite; Lx uses the uniform-deaths approximation
#' lx - dx / 2.
#'
#' @param basis A mortality basis (see [sc_qx()]).
#' @param df A data frame holding the basis, when `basis` is not the frame.
#' @param ... Passed to [sc_qx()]: column names (`age`, `qx_col`, `lx`,
#'   `deaths`, `exposure_col`) and Makeham overrides (`A`, `B`, `c`,
#'   `multiplier`).
#' @param ages `c(from, to)` age range.
#' @param radix l(first age).
#' @return A `scelo_table`.
#' @examples
#' lt <- sc_life_table()
#' head(lt)
#' sc_life_table(ages = c(60, 100), radix = 1000)
#' @export
sc_life_table <- function(basis = NULL, df = NULL, ..., ages = NULL, radix = 1e5) {
  .sc_tool("sc_life_table", .sc_args(ages = ages, radix = radix), .sc_basis_input(basis, df), {
    q <- sc_qx(basis, df, ..., ages = .sc_ages_arg(ages))
    L <- .sc_life_cols(q, radix)
    out <- data.frame(age = L$age, qx = L$qx, px = L$px, lx = L$lx, dx = L$dx, Lx = L$Lx, Tx = L$Tx, ex = L$ex)
    sc_table(out, title = paste0("Life table · ", q$label), basis = q$label, stage = "hard",
             notes = c(q$notes, sprintf("Radix l(%d) = %s; table closed at age %d (qx set to 1). Lx uses the uniform-deaths approximation lx − ½dx.",
                                        L$age[1], .sc_comma(radix), L$age[length(L$age)])))
  })
}

#' Commutation functions
#'
#' Age, lx, dx, v^x, Dx, Nx, Cx, Mx, Rx, Sx at interest `i`; v^x is measured
#' from the first tabulated age, so ratios (Nx/Dx, Mx/Dx, ...) are
#' unaffected.
#'
#' @inheritParams sc_life_table
#' @param i Annual effective interest rate.
#' @return A `scelo_table`.
#' @examples
#' cm <- sc_commutation(i = 0.04)
#' cm[cm$age == 65, ]
#' @export
sc_commutation <- function(basis = NULL, df = NULL, ..., i = 0.04, ages = NULL, radix = 1e5) {
  .sc_tool("sc_commutation", .sc_args(i = i, ages = ages, radix = radix), .sc_basis_input(basis, df), {
    q <- sc_qx(basis, df, ..., ages = .sc_ages_arg(ages))
    L <- .sc_life_cols(q, radix)
    C <- .sc_commutation(L, i)
    out <- data.frame(age = L$age, lx = L$lx, dx = L$dx, `v^x` = C$vx, Dx = C$Dx, Nx = C$Nx, Cx = C$Cx, Mx = C$Mx, Rx = C$Rx, Sx = C$Sx, check.names = FALSE)
    sc_table(out, title = sprintf("Commutation functions · %s · i = %s", q$label, .sc_pct(i)), basis = sprintf("%s · i = %s", q$label, .sc_pct(i)), stage = "hard",
             notes = c(q$notes, sprintf("Interest %s p.a.; v^x is measured from the first tabulated age (%d), so ratios (Nx/Dx, Mx/Dx …) are unaffected. Radix %s.",
                                        .sc_pct(i), L$age[1], .sc_comma(radix))))
  })
}

.sc_term_n <- function(n) {
  if (is.null(n)) return(NULL)
  if (length(n) != 1 || is.na(n) || n < 0) stop("n must be a positive number of years", call. = FALSE)
  if (n == 0) return(NULL)
  as.integer(n)
}

#' Annuity and assurance factors by age
#'
#' ax-due = Nx/Dx (annuity-due), ax = ax-due - 1, Ax = Mx/Dx (end-of-year
#' benefit) and, with a term `n`, ax-due:n = (Nx - Nx+n)/Dx,
#' A1x:n = (Mx - Mx+n)/Dx, nEx = Dx+n/Dx, Ax:n = A1x:n + nEx. The columns
#' are named as actuaries write them: `äx`, `ax`, `Ax`, `äx:n`, `A¹x:n`,
#' `nEx`, `Ax:n`.
#'
#' @inheritParams sc_commutation
#' @param n Term in years (`NULL` for whole-life factors only).
#' @return A `scelo_table`, blank where x + n runs past the table.
#' @examples
#' f <- sc_factors(i = 0.04, n = 10)
#' f[f$age == 40, ]
#' @export
sc_factors <- function(basis = NULL, df = NULL, ..., i = 0.04, n = NULL, ages = NULL) {
  n <- .sc_term_n(n)
  .sc_tool("sc_factors", .sc_args(i = i, n = n, ages = ages), .sc_basis_input(basis, df), {
    q <- sc_qx(basis, df, ..., ages = .sc_ages_arg(ages))
    L <- .sc_life_cols(q, 1e5)
    C <- .sc_commutation(L, i)
    Dx <- C$Dx
    Nx <- C$Nx
    Mx <- C$Mx
    out <- data.frame(age = L$age, Nx / Dx, Nx / Dx - 1, Mx / Dx, check.names = FALSE)
    names(out) <- c("age", "äx", "ax", "Ax")
    if (!is.null(n)) {
      m <- length(Dx)
      kn <- seq_len(m) + n
      ok <- kn <= m
      idx <- ifelse(ok, kn, 1L)
      out[[sprintf("äx:%d", n)]] <- ifelse(ok, (Nx - Nx[idx]) / Dx, NA_real_)
      out[[sprintf("A¹x:%d", n)]] <- ifelse(ok, (Mx - Mx[idx]) / Dx, NA_real_)
      out[[sprintf("%dEx", n)]] <- ifelse(ok, Dx[idx] / Dx, NA_real_)
      out[[sprintf("Ax:%d", n)]] <- ifelse(ok, (Mx - Mx[idx] + Dx[idx]) / Dx, NA_real_)
    }
    note <- "äx = Nx/Dx (annuity-due), ax = äx − 1, Ax = Mx/Dx (whole-life assurance, end-of-year benefit)"
    if (!is.null(n)) {
      note <- paste0(note, sprintf("; äx:%d = (Nx − Nx+%d)/Dx, A¹x:%d = (Mx − Mx+%d)/Dx, %dEx = Dx+%d/Dx, Ax:%d = A¹x:%d + %dEx. Blank where x + %d runs past the table.", n, n, n, n, n, n, n, n, n, n))
    }
    sc_table(out, title = paste0(sprintf("Annuity & assurance factors · %s · i = %s", q$label, .sc_pct(i)), if (!is.null(n)) sprintf(" · n = %d", n) else ""),
             basis = sprintf("%s · i = %s", q$label, .sc_pct(i)), stage = "hard", notes = c(q$notes, paste0(note, sprintf(" Interest %s.", .sc_pct(i)))))
  })
}

#' One annuity or assurance factor
#'
#' `sc_annuity()`: ax-due (`due = TRUE`) or ax at age x, temporary for `n`
#' years if given. `sc_assurance()`: Ax (whole life), A1x:n (term, `n`
#' given) or Ax:n (`endowment = TRUE`).
#'
#' @param x Age.
#' @inheritParams sc_factors
#' @param due Annuity-due (`TRUE`) or immediate.
#' @param endowment Endowment assurance rather than term.
#' @return A number.
#' @examples
#' sc_annuity(65, i = 0.04)
#' sc_assurance(40, i = 0.04, n = 20)
#' @export
sc_annuity <- function(x, basis = NULL, df = NULL, ..., i = 0.04, n = NULL, due = TRUE) {
  n <- .sc_term_n(n)
  f <- sc_df(sc_factors(basis, df, ..., i = i, n = n))
  row <- f[f$age == x, , drop = FALSE]
  if (!nrow(row)) stop(sprintf("age %s is not in the basis", format(x)), call. = FALSE)
  if (!is.null(n)) {
    val <- row[[sprintf("äx:%d", n)]][1]
    return(if (due) val else val - (1 - row[[sprintf("%dEx", n)]][1]))
  }
  row[[if (due) "äx" else "ax"]][1]
}

#' @rdname sc_annuity
#' @export
sc_assurance <- function(x, basis = NULL, df = NULL, ..., i = 0.04, n = NULL, endowment = FALSE) {
  n <- .sc_term_n(n)
  f <- sc_df(sc_factors(basis, df, ..., i = i, n = n))
  row <- f[f$age == x, , drop = FALSE]
  if (!nrow(row)) stop(sprintf("age %s is not in the basis", format(x)), call. = FALSE)
  if (!is.null(n)) return(row[[if (endowment) sprintf("Ax:%d", n) else sprintf("A¹x:%d", n)]][1])
  row[["Ax"]][1]
}

#' Net premium grid
#'
#' Annual net (equivalence-principle) premium per `per` of sum assured: an
#' age x term grid, payable in advance. `product` = term / endowment /
#' whole-life. P = per A / a-due with no expense loading and no margin: a
#' pure risk premium.
#'
#' @inheritParams sc_commutation
#' @param product `"term"`, `"endowment"` or `"whole-life"`.
#' @param ages `c(from, to)` for the age grid (default 20 to 65).
#' @param step Age step of the grid.
#' @param terms Policy terms (columns `n=10`, ...); ignored for whole-life.
#' @param per Sum assured the premium is quoted per.
#' @return A `scelo_table`.
#' @examples
#' sc_premium(i = 0.04, product = "term")
#' sc_premium(product = "whole-life", ages = c(30, 60), step = 10)
#' @export
sc_premium <- function(basis = NULL, df = NULL, ..., i = 0.04, product = "term", ages = NULL, step = 5, terms = c(10, 15, 20, 25, 30), per = 1000) {
  .sc_tool("sc_premium", .sc_args(i = i, product = product, ages = ages, step = step, terms = terms, per = per), .sc_basis_input(basis, df), {
    product <- tolower(product)
    product <- switch(substr(product, 1, 5), endow = "endowment", whole = "whole-life", product)
    if (!product %in% c("term", "endowment", "whole-life")) stop("product must be term, endowment or whole-life", call. = FALSE)
    ar <- .sc_ages_arg(ages)
    if (is.null(ar)) ar <- c(20L, 65L)
    lo <- if (is.na(ar[1])) 20L else ar[1]
    hi <- if (is.na(ar[2])) 65L else ar[2]
    terms <- if (length(terms)) as.integer(terms) else c(10L, 15L, 20L, 25L, 30L)
    max_term <- max(terms)
    law_like <- is.null(basis) || is.character(basis) || (is.list(basis) && !is.data.frame(basis) && !inherits(basis, "scelo_qx"))
    want <- if (law_like && is.null(df)) c(min(lo, 20L), max(hi + max_term, 110L)) else NULL
    q <- sc_qx(basis, df, ..., ages = want)
    L <- .sc_life_cols(q, 1e5)
    C <- .sc_commutation(L, i)
    Dx <- C$Dx
    Nx <- C$Nx
    Mx <- C$Mx
    m <- length(Dx)
    grid <- if (hi < lo) integer() else seq.int(lo, hi, by = step)
    k <- match(grid, L$age)
    grid <- grid[!is.na(k)]
    k <- k[!is.na(k)]
    if (!length(grid)) stop("no ages in the requested range are covered by the mortality basis", call. = FALSE)
    out <- data.frame(age = grid)
    if (product == "whole-life") {
      out[["whole life"]] <- per * Mx[k] / Nx[k]
    } else {
      for (n in terms) {
        kn <- k + n
        ok <- kn <= m
        idx <- ifelse(ok, kn, 1L)
        adue <- (Nx[k] - Nx[idx]) / Dx[k]
        term <- (Mx[k] - Mx[idx]) / Dx[k]
        endow <- term + Dx[idx] / Dx[k]
        out[[sprintf("n=%d", n)]] <- ifelse(ok, per * (if (product == "endowment") endow else term) / adue, NA_real_)
      }
    }
    label <- c(term = "term assurance", endowment = "endowment", `whole-life` = "whole-life")[[product]]
    sc_table(out, title = sprintf("Net premium per %s SA · %s · %s · i = %s", .sc_comma(per), label, q$label, .sc_pct(i)),
             basis = sprintf("%s · %s · i = %s", label, q$label, .sc_pct(i)), stage = "hard",
             notes = c(q$notes,
                       sprintf("Annual net (equivalence-principle) premium per %s sum assured, payable in advance throughout the term (whole of life for whole-life): P = %s·A/ä. No expense loading, no profit margin: a pure risk premium.", .sc_comma(per), .sc_comma(per)),
                       sprintf("Interest %s.", .sc_pct(i))))
  })
}

# ── experience ──────────────────────────────────────────────────────────────

.sc_band_label <- function(b, band) sprintf("%d–%d", as.integer(b), as.integer(b + band - 1))

#' Actual vs expected by age band
#'
#' Exposure, actual deaths, expected deaths = sum of exposure x qx(basis),
#' A/E and crude qx per `band`-year age band, with a total row. `expected`
#' defaults to the illustrative Makeham basis; pass a qx data frame, a named
#' qx vector, a `scelo_qx` or Makeham parameters. `by` adds a grouping
#' column.
#'
#' @param df A data frame with age, deaths and exposure columns.
#' @param expected The expected mortality basis (see [sc_qx()]).
#' @param age,deaths,exposure Column names, inferred when `NULL`.
#' @param band Width of the age bands in years.
#' @param by A grouping column.
#' @return A `scelo_table`.
#' @examples
#' x <- data.frame(age = rep(60:69, each = 3), deaths = rep(c(1, 0, 2), 10), exposure = 100)
#' sc_ae(x)
#' @export
sc_ae <- function(df, expected = NULL, age = NULL, deaths = NULL, exposure = NULL, band = 5, by = NULL) {
  .sc_tool("sc_ae", .sc_args(band = band, by = by), df, {
    a <- sc_infer(df, "age", age)
    d <- sc_infer(df, "deaths", deaths, exclude = a)
    e <- sc_infer(df, "exposure", exposure, exclude = c(a, d))
    if (!is.null(by) && !by %in% names(df)) stop(sprintf('column "%s" is not in the data (have: %s)', by, paste(names(df), collapse = ", ")), call. = FALSE)
    w_age <- round(.sc_to_num(df[[a]]))
    w_d <- .sc_to_num(df[[d]])
    w_e <- .sc_to_num(df[[e]])
    keep <- !is.na(w_age) & !is.na(w_e)
    w_age <- w_age[keep]
    w_d <- w_d[keep]
    w_e <- w_e[keep]
    w_by <- if (!is.null(by)) df[[by]][keep] else NULL
    w_d[is.na(w_d)] <- 0
    if (!length(w_age)) stop("no usable rows: age and exposure must be numeric", call. = FALSE)
    lo <- min(w_age)
    hi <- max(w_age)
    q <- if (is.null(expected)) sc_qx("makeham", ages = c(lo, hi)) else sc_qx(expected, NULL, ages = c(lo, hi))
    q_at <- q$qx[match(w_age, q$ages)]
    q_at[is.na(q_at)] <- 0
    w_x <- w_e * q_at
    bandv <- floor(w_age / band) * band
    key <- if (!is.null(by)) paste(w_by, bandv, sep = "\r") else as.character(bandv)
    uk <- unique(key)
    gi <- match(key, uk)
    first <- match(uk, key)
    sums <- rowsum(cbind(e = w_e, d = w_d, x = w_x), gi)
    g_band <- bandv[first]
    g_by <- w_by[first]
    o <- if (!is.null(by)) order(g_by, g_band, method = "radix") else order(g_band)
    ex <- sums[o, "e"]
    ac <- sums[o, "d"]
    xp <- sums[o, "x"]
    out <- data.frame(`age band` = .sc_band_label(g_band[o], band), exposure = ex, `actual deaths` = ac, `expected deaths` = xp,
                      `A/E` = ifelse(xp > 0, ac / xp, NA_real_), `crude qx` = ifelse(ex > 0, ac / ex, NA_real_), check.names = FALSE, stringsAsFactors = FALSE)
    tot <- data.frame(`age band` = "total", exposure = sum(w_e), `actual deaths` = sum(w_d), `expected deaths` = sum(w_x), check.names = FALSE, stringsAsFactors = FALSE)
    tot[["A/E"]] <- if (tot[["expected deaths"]] > 0) tot[["actual deaths"]] / tot[["expected deaths"]] else NA_real_
    tot[["crude qx"]] <- if (tot$exposure > 0) tot[["actual deaths"]] / tot$exposure else NA_real_
    if (!is.null(by)) {
      out <- cbind(stats::setNames(data.frame(g_by[o], stringsAsFactors = FALSE), by), out)
      tot <- cbind(stats::setNames(data.frame("all", stringsAsFactors = FALSE), by), tot)
    }
    out <- rbind(out, tot)
    rownames(out) <- NULL
    sc_table(out, title = sprintf("Actual vs expected · %s / %s vs %s", d, e, q$label), basis = sprintf("expected: %s", q$label), stage = "hard",
             notes = c(q$notes, sprintf("Expected deaths = exposure × qx(expected basis) at each age, summed into %s-year bands. A/E > 1 means heavier mortality than the basis.", format(band))))
  })
}

#' Group a policy file into model points
#'
#' Age band x sex x term: count, total sum assured, mean premium, mean age.
#' The output matches lifelib's basic_term model-point table, so it feeds
#' [sc_basicterm()] / [sc_lifelib_run()] directly.
#'
#' @param df A policy file.
#' @param age,sex,term,sum_assured,premium_col Column names, inferred when
#'   `NULL` (sex, term, sum assured and premium are optional).
#' @param band Width of the age bands in years.
#' @return A `scelo_table` with `model_point_id`, `age_band`,
#'   `age_at_entry`, `sex`, `policy_term`, `policy_count`, `sum_assured`,
#'   `premium_pp`.
#' @examples
#' sc_model_points(sc_sample("lifelib-mp"))
#' @export
sc_model_points <- function(df, age = NULL, sex = NULL, term = NULL, sum_assured = NULL, premium_col = NULL, band = 5) {
  .sc_tool("sc_model_points", .sc_args(band = band), df, {
    a <- sc_infer(df, "age", age)
    s <- sc_infer(df, "sex", sex, required = FALSE)
    t <- sc_infer(df, "policy_term", term, required = FALSE, exclude = a)
    sa <- sc_infer(df, "sum_assured", sum_assured, required = FALSE)
    pr <- sc_infer(df, "premium", premium_col, required = FALSE)
    agev <- .sc_to_num(df[[a]])
    keep <- !is.na(agev)
    n <- nrow(df)
    sexv <- if (is.null(s)) rep("all", n) else {
      v <- df[[s]]
      u <- substr(toupper(trimws(as.character(v))), 1, 1)
      u[is.na(v) | is.na(u) | u == ""] <- "?"
      u
    }
    termv <- if (is.null(t)) rep(NA_real_, n) else .sc_to_num(df[[t]])
    sav <- if (is.null(sa)) rep(0, n) else { v <- .sc_to_num(df[[sa]]); v[is.na(v)] <- 0; v }
    premv <- if (is.null(pr)) rep(0, n) else { v <- .sc_to_num(df[[pr]]); v[is.na(v)] <- 0; v }
    agev <- agev[keep]
    sexv <- sexv[keep]
    termv <- termv[keep]
    sav <- sav[keep]
    premv <- premv[keep]
    bandv <- floor(agev / band) * band
    key <- paste(bandv, sexv, termv, sep = "\r")
    uk <- unique(key)
    gi <- match(key, uk)
    first <- match(uk, key)
    cnt <- tabulate(gi, nbins = length(uk))
    age_mean <- as.numeric(rowsum(agev, gi)) / cnt
    sa_sum <- as.numeric(rowsum(sav, gi))
    prem_mean <- as.numeric(rowsum(premv, gi)) / cnt
    g_band <- bandv[first]
    g_sex <- sexv[first]
    g_term <- termv[first]
    o <- order(g_band, g_sex, g_term, method = "radix", na.last = TRUE)
    out <- data.frame(
      model_point_id = sprintf("MP%04d", seq_along(uk)),
      age_band = .sc_band_label(g_band[o], band),
      age_at_entry = as.integer(round(age_mean[o])),
      sex = g_sex[o],
      policy_term = g_term[o],
      policy_count = cnt[o],
      sum_assured = sa_sum[o],
      premium_pp = prem_mean[o],
      stringsAsFactors = FALSE
    )
    sc_table(out, title = sprintf("Model points · %s policies → %d groups", .sc_int_comma(nrow(df)), nrow(out)), basis = sprintf("%sy bands", format(band)), stage = "hard", notes = c(
      sprintf("Grouped by %s-year age band%s%s: policy_count = policies in the group, sum_assured = total, premium_pp = mean per policy, age_at_entry = group mean (rounded). Shape matches lifelib's basic_term model-point table.",
              format(band), if (!is.null(s)) " × sex" else "", if (!is.null(t)) " × policy term" else ""),
      "Grouping loses within-band heterogeneity: validate a liability metric on grouped vs seriatim before relying on it."
    ))
  })
}

# ── survival helpers ────────────────────────────────────────────────────────

#' Survival curve from a qx vector
#'
#' tpx from the qx of one life: the survival curve (duration 0 to n) or a
#' single t-year probability from the first age.
#'
#' @param q Numeric vector of qx (names, if any, are ignored).
#' @param t A duration; `NULL` for the whole curve.
#' @return A named numeric vector (names = durations), or one number.
#' @examples
#' sc_survival(c(0.1, 0.2, 1))
#' sc_survival(c(0.1, 0.2, 1), t = 2)
#' @export
sc_survival <- function(q, t = NULL) {
  qs <- as.numeric(q)
  s <- stats::setNames(c(1, cumprod(1 - qs)), seq(0, length(qs)))
  if (!is.null(t)) unname(s[t + 1]) else s
}

#' Life expectancy from a qx vector
#'
#' Complete (ex, uniform deaths: curtate + 1/2) or curtate life expectancy
#' from the qx of one life.
#'
#' @param q Numeric vector of qx.
#' @param curtate Curtate (`TRUE`) or complete expectancy.
#' @return A number.
#' @examples
#' sc_life_expectancy(sc_makeham(40:110))
#' @export
sc_life_expectancy <- function(q, curtate = FALSE) {
  curt <- sum(cumprod(1 - as.numeric(q)))
  if (curtate) curt else curt + 0.5
}

#' Close a mortality table
#'
#' Set qx = 1 at the last age (or at `omega`), truncating beyond it.
#'
#' @param q A named numeric vector of qx by age (unnamed: ages 0, 1, ...).
#' @param omega The closing age.
#' @return The closed vector.
#' @examples
#' sc_close_table(sc_makeham(60:120), omega = 110)
#' @export
sc_close_table <- function(q, omega = NULL) {
  s <- q
  if (!is.null(omega)) {
    idx <- if (is.null(names(s))) seq_along(s) - 1 else as.numeric(names(s))
    s <- s[!is.na(idx) & idx <= omega]
  }
  if (!length(s)) stop("no ages at or below omega", call. = FALSE)
  s[length(s)] <- 1
  s
}

# ── graduation ──────────────────────────────────────────────────────────────

#' Whittaker-Henderson graduation
#'
#' Minimise sum of w (g - u)^2 + h sum of (Delta^z g)^2. Returns crude and
#' graduated qx and the residuals. `crude` is qx by age (a named numeric
#' vector) or a data frame with age + deaths + exposure (weights default to
#' exposure). Graduates log qx by default (`log = TRUE`) so the smoothed
#' rates stay positive; h = smoothness, z = difference order.
#'
#' @param crude A named numeric vector of crude qx by age, or a data frame.
#' @param weights Weights per age (`NULL`: exposure when available, else 1).
#' @param h Smoothing parameter.
#' @param z Order of the difference penalty.
#' @param log Graduate on the log scale.
#' @return A `scelo_table`: age, crude, graduated, residual, weight.
#' @examples
#' crude <- sc_makeham(30:89) * exp(rnorm(60, 0, 0.15))
#' sc_graduate(crude, h = 100)
#' @export
sc_graduate <- function(crude, weights = NULL, h = 100, z = 2, log = TRUE) {
  .sc_tool("sc_graduate", .sc_args(h = h, z = z, log = log), if (is.data.frame(crude)) crude else NULL, {
    if (is.data.frame(crude)) {
      q <- sc_qx(NULL, crude)
      ages <- as.numeric(q$ages)
      y <- q$qx
      if (is.null(weights)) {
        a <- sc_infer(crude, "age")
        e <- sc_infer(crude, "exposure", required = FALSE)
        if (!is.null(e)) {
          ag <- round(.sc_to_num(crude[[a]]))
          ev <- .sc_to_num(crude[[e]])
          ok <- !is.na(ag) & !is.na(ev)
          w_age <- rowsum(ev[ok], ag[ok])
          weights <- as.numeric(w_age[match(ages, as.numeric(rownames(w_age))), 1])
          weights[is.na(weights)] <- 0
        }
      }
    } else {
      y <- as.numeric(crude)
      ages <- if (is.null(names(crude))) seq_along(y) - 1 else as.numeric(names(crude))
    }
    n <- length(y)
    w <- if (is.null(weights)) rep(1, n) else as.numeric(weights)
    w[!is.finite(w) | w <= 0] <- 0
    if (log) {
      ok <- !is.na(y) & y > 0
      yy <- numeric(n)
      yy[ok] <- base::log(y[ok])
      w[!ok] <- 0
    } else {
      yy <- y
    }
    if (any(w > 0)) w <- w / mean(w[w > 0])
    K <- diag(n)
    for (k in seq_len(z)) K <- diff(K)
    A <- diag(w, nrow = n) + h * crossprod(K)
    g <- as.numeric(solve(A, w * yy))
    grad <- if (log) exp(g) else g
    out <- data.frame(age = if (all(ages == round(ages))) as.integer(ages) else ages, crude = y, graduated = grad, residual = y - grad, weight = w)
    sc_table(out, title = sprintf("Whittaker–Henderson graduation · h = %s, z = %s", .sc_g(h), format(z)),
             basis = sprintf("WH(h=%s, z=%s)%s", .sc_g(h), format(z), if (log) " on log qx" else ""), stage = "hard", notes = c(
      "Minimises Σ w·(graduated − crude)² + h·Σ(Δᶻ graduated)²: larger h smooths harder; z = 2 penalises curvature, z = 3 penalises change of curvature.",
      "Check the residual signs and a chi-square / runs test before adopting; a graduation that drifts from the crude rates at the old ages is the usual failure."
    ))
  })
}

# ── Lee-Carter ──────────────────────────────────────────────────────────────

#' Lee-Carter mortality projection
#'
#' SVD fit of log m(x, t) = a_x + b_x k_t on a long (year, age, qx or mx)
#' file, with constraints sum b_x = 1, sum k_t = 0, and a
#' random-walk-with-drift forecast of k_t. The forecast table gives the
#' projected rate at `headline_age` with a 95 percent interval (drift
#' uncertainty and innovation variance), plus the implied annual
#' improvement in the notes.
#'
#' @param df A data frame with year, age and rate columns.
#' @param year,age,rate Column names, inferred when `NULL` (`rate`: qx,
#'   else mx).
#' @param horizon Years to project.
#' @param headline_age Age reported in the forecast table (nearest
#'   available).
#' @return A `scelo_lee_carter`: a list with `ax`, `bx` (named by age),
#'   `kt` (named by year), `drift`, `drift_se`, `forecast` (a
#'   `scelo_table`) and `explained` (share of variance in the first
#'   component).
#' @examples
#' d <- expand.grid(year = 1990:2019, age = 50:90)
#' d$qx <- exp(-9 + 0.09 * d$age - 0.015 * (d$year - 1990))
#' lc <- sc_lee_carter(d, horizon = 5)
#' lc$drift
#' @export
sc_lee_carter <- function(df, year = NULL, age = NULL, rate = NULL, horizon = 10, headline_age = 65) {
  .sc_tool("sc_lee_carter", .sc_args(horizon = horizon, headline_age = headline_age), df, {
    y <- sc_infer(df, "year", year)
    a <- sc_infer(df, "age", age, exclude = y)
    r <- if (!is.null(rate)) sc_infer(df, "qx", rate) else sc_infer(df, "qx", NULL, required = FALSE, exclude = c(y, a))
    if (is.null(r)) r <- sc_infer(df, "mx", NULL, exclude = c(y, a))
    yr <- .sc_to_num(df[[y]])
    ag <- .sc_to_num(df[[a]])
    m <- .sc_to_num(df[[r]])
    ok <- !is.na(yr) & !is.na(ag) & !is.na(m) & m > 0
    piv <- tapply(m[ok], list(yr[ok], ag[ok]), mean)
    piv <- piv[, colSums(is.na(piv)) == 0, drop = FALSE]
    if (nrow(piv) < 3 || ncol(piv) < 2) stop("Lee–Carter needs at least 3 years × 2 ages with positive rates", call. = FALSE)
    M <- base::log(unclass(piv))
    ax_ <- colMeans(M)
    C <- sweep(M, 2, ax_)
    sv <- svd(C)
    b_raw <- sv$v[, 1]
    k_raw <- sv$u[, 1] * sv$d[1]
    s <- sum(b_raw)
    bx_ <- b_raw / s
    kt_ <- k_raw * s
    kt_ <- kt_ - mean(kt_)
    explained <- sv$d[1]^2 / sum(sv$d^2)
    dk <- diff(kt_)
    drift <- mean(dk)
    sigma <- if (length(dk) > 1) stats::sd(dk) else 0
    drift_se <- if (length(dk)) sigma / sqrt(length(dk)) else 0
    years <- as.numeric(rownames(piv))
    ages <- as.numeric(colnames(piv))
    h <- seq_len(horizon)
    k_last <- kt_[length(kt_)]
    k_fc <- k_last + drift * h
    k_sd <- sqrt(h * sigma^2 + (h * drift_se)^2)
    ages_i <- as.integer(ages)
    ha <- if (headline_age %in% ages_i) as.integer(headline_age) else ages_i[which.min(abs(ages_i - headline_age))]
    j <- which(ages_i == ha)[1]
    m_now <- exp(ax_[j] + bx_[j] * k_last)
    m_fc <- exp(ax_[j] + bx_[j] * k_fc)
    lo <- exp(ax_[j] + bx_[j] * (k_fc - 1.96 * k_sd * sign(bx_[j])))
    hi <- exp(ax_[j] + bx_[j] * (k_fc + 1.96 * k_sd * sign(bx_[j])))
    fc <- data.frame(year = as.integer(years[length(years)] + h), kt = k_fc, m_fc, lower95 = pmin(lo, hi), upper95 = pmax(lo, hi), check.names = FALSE)
    names(fc)[3] <- sprintf("rate@%d", ha)
    improvement <- 1 - (m_fc[horizon] / m_now)^(1 / horizon)
    t <- sc_table(fc, title = sprintf("Lee–Carter forecast · age %d · %sy", ha, format(horizon)),
                  basis = sprintf("SVD fit on %d years × %d ages · RWD drift %.4f", length(years), length(ages), drift), stage = "hard", notes = c(
      sprintf("log m(x,t) = a_x + b_x·k_t with Σb = 1, Σk = 0; k_t projected as a random walk with drift %.4f (σ %.4f); interval = ±1.96·√(h·σ² + (h·se_drift)²).", drift, sigma),
      sprintf("Implied annual improvement at age %d: %.2f%% (first component explains %.1f%% of the log-rate variance).", ha, improvement * 100, explained * 100)
    ))
    structure(list(ax = stats::setNames(as.numeric(ax_), ages_i), bx = stats::setNames(as.numeric(bx_), ages_i), kt = stats::setNames(as.numeric(kt_), as.integer(years)),
                   drift = drift, drift_se = drift_se, forecast = t, explained = explained), class = c("scelo_lee_carter", "list"))
  })
}

#' @export
print.scelo_lee_carter <- function(x, ...) {
  cat(sprintf("Lee–Carter: %d ages × %d years · drift %.4f (se %.4f) · first SVD component explains %.1f%%\n",
              length(x$ax), length(x$kt), x$drift, x$drift_se, 100 * x$explained))
  print(x$forecast, ...)
  invisible(x)
}

# ── Kaplan-Meier ────────────────────────────────────────────────────────────

.SC_EVENT_TOKENS <- c("1", "true", "yes", "y", "dead", "died", "event", "claim")

.sc_event_flag <- function(v, tokens = .SC_EVENT_TOKENS) {
  s <- tolower(trimws(as.character(v)))
  as.integer(!is.na(s) & s %in% tokens)
}

.sc_km_one <- function(t, e) {
  times <- sort(unique(t[e == 1]))
  n <- length(t)
  st <- sort(t)
  at_risk <- as.numeric(n - findInterval(times, st, left.open = TRUE))
  d_t <- as.numeric(tabulate(match(t[e == 1], times), nbins = length(times)))
  cens <- match(t[e == 0], times)
  c_t <- tabulate(cens[!is.na(cens)], nbins = length(times))
  S <- cumprod(1 - d_t / at_risk)
  var_acc <- cumsum(ifelse(at_risk - d_t > 0, d_t / (at_risk * (at_risk - d_t)), 0))
  se <- S * sqrt(var_acc)
  inside <- S > 0 & S < 1
  lo <- hi <- S
  z <- 1.96 * sqrt(var_acc[inside]) / abs(base::log(S[inside]))
  lo[inside] <- S[inside]^exp(z)
  hi[inside] <- S[inside]^exp(-z)
  data.frame(time = times, at_risk = as.integer(at_risk), events = as.integer(d_t), censored = as.integer(c_t), S = S, se = se, lower95 = lo, upper95 = hi)
}

#' Kaplan-Meier survival
#'
#' Time, number at risk, events, censored, S(t), Greenwood standard error
#' and 95 percent log(-log S) bounds, optionally per group.
#'
#' @param df A data frame with a duration and an event column.
#' @param duration,event Column names, inferred when `NULL`. Event values
#'   1 / TRUE / yes / y / dead / died / event / claim / lapsed count as
#'   events; anything else is censored.
#' @param by A grouping column.
#' @return A `scelo_table`.
#' @examples
#' sc_kaplan_meier(data.frame(time = c(1, 2, 2, 3, 5, 8, 8, 9), status = c(1, 1, 0, 1, 0, 1, 1, 0)))
#' @export
sc_kaplan_meier <- function(df, duration = NULL, event = NULL, by = NULL) {
  .sc_tool("sc_kaplan_meier", .sc_args(by = by), df, {
    d <- sc_infer(df, "duration", duration)
    e <- sc_infer(df, "event", event, exclude = d)
    if (!is.null(by) && !by %in% names(df)) stop(sprintf('column "%s" is not in the data (have: %s)', by, paste(names(df), collapse = ", ")), call. = FALSE)
    t <- .sc_to_num(df[[d]])
    ev <- .sc_event_flag(df[[e]], c(.SC_EVENT_TOKENS, "lapsed"))
    keep <- !is.na(t)
    if (!is.null(by)) {
      g <- df[[by]]
      keep <- keep & !is.na(g)
      t <- t[keep]
      ev <- ev[keep]
      g <- g[keep]
      lv <- unique(g)
      lv <- lv[order(lv, method = "radix")]
      frames <- lapply(lv, function(l) {
        f <- .sc_km_one(t[g == l], ev[g == l])
        cbind(stats::setNames(data.frame(rep(l, nrow(f)), stringsAsFactors = FALSE), by), f)
      })
      out <- do.call(rbind, frames)
    } else {
      out <- .sc_km_one(t[keep], ev[keep])
    }
    rownames(out) <- NULL
    sc_table(out, title = paste0("Kaplan–Meier survival", if (!is.null(by)) paste0(" by ", by) else ""), basis = sprintf("%s / %s", d, e), stage = "hard", notes = c(
      "S(t) = Π (1 − d_j/n_j) over event times ≤ t; SE by Greenwood; 95 % bounds on the log(−log S) scale."
    ))
  })
}

# ── exposure ────────────────────────────────────────────────────────────────

# pandas.to_datetime(errors = "coerce") for the date shapes actuarial extracts use.
.sc_date <- function(v) {
  if (inherits(v, "Date")) return(v)
  if (inherits(v, "POSIXt")) return(as.Date(v))
  if (is.numeric(v)) return(as.Date(v, origin = "1970-01-01"))
  s <- trimws(as.character(v))
  out <- rep(as.Date(NA), length(s))
  nz <- !is.na(s) & nzchar(s)
  if (any(nz)) {
    out[nz] <- tryCatch(as.Date(s[nz], tryFormats = c("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y", "%d-%m-%Y", "%Y%m%d"), optional = TRUE),
                        error = function(err) rep(as.Date(NA), sum(nz)))
  }
  out
}

#' Central exposure by age
#'
#' Policy-years at risk by attained age (and calendar year), from start / end
#' dates, with deaths if `event` is given. Age is attained age from `birth`
#' (or the entry `age_col` advanced from `start`); each policy's time at
#' risk is split across the integer ages (age last birthday) it passes
#' through.
#'
#' @param df A data frame.
#' @param start,end Date column names (ISO dates, Date or POSIXt).
#' @param birth Date-of-birth column; when `NULL`, `age_col` (entry age) is
#'   used.
#' @param age_col Entry-age column, inferred when `NULL` and `birth` is not
#'   given.
#' @param event Event column (1 / TRUE / yes / dead / died / event / claim
#'   count as deaths).
#' @param by_year Split the exposure by calendar year as well.
#' @param age_basis Age definition; only `"last"` (age last birthday) is
#'   implemented.
#' @return A `scelo_table`: age, (year), exposure, deaths, crude_qx.
#' @examples
#' sc_exposure(data.frame(start = "2020-01-01", end = "2022-01-01", age = 40.5, died = 1),
#'             "start", "end", event = "died")
#' @export
sc_exposure <- function(df, start, end, birth = NULL, age_col = NULL, event = NULL, by_year = FALSE, age_basis = "last") {
  .sc_tool("sc_exposure", .sc_args(start = start, end = end, birth = birth, event = event, by_year = by_year), df, {
    for (col in c(start, end, birth, event)) if (!col %in% names(df)) stop(sprintf('column "%s" is not in the data (have: %s)', col, paste(names(df), collapse = ", ")), call. = FALSE)
    s <- .sc_date(df[[start]])
    e <- .sc_date(df[[end]])
    age0 <- if (!is.null(birth)) as.numeric(s - .sc_date(df[[birth]])) / 365.25 else .sc_to_num(df[[sc_infer(df, "age", age_col)]])
    ev <- if (!is.null(event)) .sc_event_flag(df[[event]]) else rep(0L, nrow(df))
    ok <- !is.na(s) & !is.na(e) & !is.na(age0) & e > s
    idx <- which(ok)
    a0 <- age0[idx]
    total <- as.numeric(e[idx] - s[idx]) / 365.25
    k_lo <- floor(a0 + 1e-9)
    k_hi <- floor(a0 + total - 1e-9)
    npc <- pmax(0, k_hi - k_lo + 1)
    rep_i <- rep(seq_along(idx), npc)
    k <- rep(k_lo, npc) + sequence(npc) - 1
    a0r <- a0[rep_i]
    from <- pmax(a0r, k)
    to <- pmin(a0r + total[rep_i], k + 1)
    expo <- to - from
    piece <- expo > 1e-9
    k <- k[piece]
    expo <- expo[piece]
    yr_e <- if (by_year) as.POSIXlt(as.POSIXct(s[idx][rep_i[piece]], tz = "UTC") + (from[piece] - a0r[piece]) * 365.25 * 86400, tz = "UTC")$year + 1900 else rep(0L, length(k))
    died <- ev[idx] == 1
    a_end <- floor(a0[died] + total[died] - 1e-9)
    yr_d <- if (by_year) as.POSIXlt(e[idx][died])$year + 1900 else rep(0L, length(a_end))
    key_e <- paste(k, yr_e)
    key_d <- paste(a_end, yr_d)
    keys <- unique(c(key_e, key_d))
    if (length(keys)) {
      parts <- do.call(rbind, strsplit(keys, " ", fixed = TRUE))
      age_k <- as.integer(parts[, 1])
      yr_k <- as.integer(parts[, 2])
      o <- order(age_k, yr_k)
      keys <- keys[o]
      age_k <- age_k[o]
      yr_k <- yr_k[o]
      exp_sum <- if (length(key_e)) rowsum(expo, key_e) else NULL
      dth_sum <- if (length(key_d)) rowsum(rep(1, length(key_d)), key_d) else NULL
      exposure <- if (is.null(exp_sum)) rep(0, length(keys)) else { v <- exp_sum[match(keys, rownames(exp_sum)), 1]; v[is.na(v)] <- 0; v }
      deaths <- if (is.null(dth_sum)) rep(0, length(keys)) else { v <- dth_sum[match(keys, rownames(dth_sum)), 1]; v[is.na(v)] <- 0; v }
      out <- data.frame(age = age_k)
      if (by_year) out$year <- yr_k
      out$exposure <- as.numeric(exposure)
      out$deaths <- as.numeric(deaths)
      out$crude_qx <- ifelse(out$exposure > 0, out$deaths / out$exposure, NA_real_)
    } else {
      out <- data.frame(age = integer(), exposure = numeric(), deaths = numeric())
      if (by_year) out <- data.frame(age = integer(), year = integer(), exposure = numeric(), deaths = numeric())
    }
    sc_table(out, title = paste0("Central exposure by age", if (by_year) " × year" else ""), basis = "policy-years, age last birthday", stage = "hard", notes = c(
      "Exposure in policy-years split at each birthday; deaths are allocated to the age at exit. Crude qx = deaths / exposure is a central rate (m_x); convert with q = m/(1 + m/2) if an initial rate is needed."
    ))
  })
}

# ── BasicTerm projection (lifelib basiclife port) ──────────────────────────

#' Scelo's illustrative BasicTerm assumptions
#'
#' The assumption set [sc_basicterm()] projects with (apps/web
#' lifelibBasicTerm.ts DEFAULT_ASSUMPTIONS): Makeham mortality, a level
#' annual lapse rate, per-policy acquisition and monthly maintenance
#' expenses, a flat discount rate and the pricing loading used when the
#' model-point file carries no premium. Override any of them by name.
#'
#' @param mort_A,mort_B,mort_c Makeham parameters of q = clamp(A + B c^x, 0, 0.95).
#' @param lapse_rate Annual lapse rate.
#' @param expense_acq_pp Acquisition expense per policy at issue.
#' @param expense_maint_pp_mth Maintenance expense per policy-month.
#' @param disc_rate Annual discount rate.
#' @param pricing_loading Loading on SA q / 12 when premiums are derived.
#' @return A named list.
#' @examples
#' sc_basicterm_assumptions(lapse_rate = 0.08)
#' @export
sc_basicterm_assumptions <- function(mort_A = 0.00022, mort_B = 2.7e-6, mort_c = 1.124, lapse_rate = 0.05, expense_acq_pp = 100, expense_maint_pp_mth = 5,
                                     disc_rate = 0.03, pricing_loading = 1.12) {
  list(mort_A = mort_A, mort_B = mort_B, mort_c = mort_c, lapse_rate = lapse_rate, expense_acq_pp = expense_acq_pp, expense_maint_pp_mth = expense_maint_pp_mth,
       disc_rate = disc_rate, pricing_loading = pricing_loading)
}

#' BasicTerm monthly projection
#'
#' Monthly term-life projection of a model-point file with lifelib
#' BasicTerm_ME semantics, in base R. Columns inferred: age_at_entry,
#' sum_assured, policy_term, and optionally sex, policy_count,
#' duration_mth, premium_pp. Mortality is Makeham q = clamp(A + B c^x, 0,
#' 0.95) converted to monthly; level annual lapse; acquisition expense once
#' at issue, maintenance monthly; premiums default to SA q / 12 x loading
#' when the file has none. Returns the aggregate monthly cash flows with
#' PVs (attribute `pv`) and the break-even month (attribute
#' `break_even_month`, also in the notes).
#'
#' @param mp A model-point file (see [sc_model_points()]).
#' @param assumptions A list as from [sc_basicterm_assumptions()]; missing
#'   entries take the defaults.
#' @param max_months Projection cap in months.
#' @return A `scelo_table`: month, premiums, claims, expenses, net_cf,
#'   discount, pv_net_cf.
#' @examples
#' bt <- sc_basicterm(sc_sample("lifelib-mp"))
#' attr(bt, "pv")
#' @export
sc_basicterm <- function(mp, assumptions = NULL, max_months = 1200) {
  .sc_tool("sc_basicterm", .sc_args(max_months = max_months), mp, {
    defaults <- sc_basicterm_assumptions()
    extra <- setdiff(names(assumptions), names(defaults))
    if (length(extra)) stop(sprintf("unknown assumption(s): %s (know %s)", paste(extra, collapse = ", "), paste(names(defaults), collapse = ", ")), call. = FALSE)
    asm <- utils::modifyList(defaults, as.list(assumptions %||% list()))
    a <- sc_infer(mp, "age", NULL)
    sa <- sc_infer(mp, "sum_assured", NULL)
    tm <- sc_infer(mp, "policy_term", NULL, exclude = a)
    cnt <- sc_infer(mp, "count", NULL, required = FALSE)
    dur <- names(mp)[gsub("_", "", tolower(names(mp)), fixed = TRUE) %in% c("durationmth", "durationmonths", "duration", "durmth", "elapsedmth")][1]
    prem <- sc_infer(mp, "premium", NULL, required = FALSE)
    age0 <- .sc_to_num(mp[[a]])
    sum_assured <- .sc_to_num(mp[[sa]])
    term_y <- .sc_to_num(mp[[tm]])
    count <- if (!is.null(cnt)) { v <- .sc_to_num(mp[[cnt]]); v[is.na(v)] <- 1; v } else rep(1, nrow(mp))
    duration <- if (!is.na(dur)) { v <- .sc_to_num(mp[[dur]]); v[is.na(v)] <- 0; v } else rep(0, nrow(mp))
    ok <- is.finite(age0) & is.finite(sum_assured) & is.finite(term_y) & age0 > 0 & sum_assured > 0 & term_y > 0
    dropped <- sum(!ok)
    age0 <- age0[ok]
    sum_assured <- sum_assured[ok]
    term_y <- term_y[ok]
    count <- count[ok]
    duration <- duration[ok]
    n <- length(age0)
    if (n == 0) stop("no usable model points: need age_at_entry, sum_assured and policy_term > 0", call. = FALSE)
    q_annual <- function(x) pmin(pmax(asm$mort_A + asm$mort_B * asm$mort_c^x, 0), 0.95)
    if (!is.null(prem)) {
      premium_pp <- .sc_to_num(mp[[prem]])[ok]
      premium_pp[is.na(premium_pp)] <- 0
      if (grepl("annual", tolower(prem), fixed = TRUE) || endsWith(tolower(prem), "_pa")) premium_pp <- premium_pp / 12
      source <- "model-point file"
    } else {
      premium_pp <- pmax(sum_assured * (q_annual(age0) / 12) * asm$pricing_loading, 0.01)
      source <- "SA × q(x0)/12 × loading"
    }
    term_m <- floor(term_y * 12) - duration
    horizon <- as.integer(min(max_months, max(1, max(term_m, na.rm = TRUE))))
    lapse_m <- 1 - (1 - asm$lapse_rate)^(1 / 12)
    pols <- as.numeric(count)
    prem_cf <- claim_cf <- exp_cf <- net_cf <- numeric(horizon)
    disc <- (1 + asm$disc_rate)^(-(seq_len(horizon) - 1) / 12)
    used <- horizon
    for (t in seq_len(horizon) - 1) {
      active <- (t < term_m) & (pols > 1e-8)
      if (!any(active)) {
        used <- t
        break
      }
      act <- as.numeric(active)
      age_now <- age0 + (duration + t) / 12
      qm <- 1 - (1 - q_annual(age_now))^(1 / 12)
      pd_ <- act * pols * qm
      pl <- act * (pols - pd_) * lapse_m
      claims <- pd_ * sum_assured
      prems <- act * pols * premium_pp
      acq <- as.numeric(active & t == 0 & duration == 0) * asm$expense_acq_pp * pols
      exps <- acq + act * pols * asm$expense_maint_pp_mth
      prem_cf[t + 1] <- sum(prems)
      claim_cf[t + 1] <- sum(claims)
      exp_cf[t + 1] <- sum(exps)
      net_cf[t + 1] <- prem_cf[t + 1] - claim_cf[t + 1] - exp_cf[t + 1]
      pols <- pols - pd_ - pl
    }
    if (used < horizon) {
      keep <- seq_len(used)
      prem_cf <- prem_cf[keep]
      claim_cf <- claim_cf[keep]
      exp_cf <- exp_cf[keep]
      net_cf <- net_cf[keep]
      disc <- disc[keep]
    }
    out <- data.frame(month = seq_along(net_cf) - 1L, premiums = prem_cf, claims = claim_cf, expenses = exp_cf, net_cf = net_cf, discount = disc, pv_net_cf = net_cf * disc)
    pv <- list(premiums = sum(prem_cf * disc), claims = sum(claim_cf * disc), expenses = sum(exp_cf * disc), net = sum(net_cf * disc))
    cum <- cumsum(net_cf)
    j <- which(cum[-1] >= 0)
    be <- if (length(j)) as.integer(j[1]) else NA_integer_
    t <- sc_table(out, title = sprintf("BasicTerm projection · %s model points · %d months", .sc_int_comma(n), length(net_cf)),
                  basis = sprintf("lifelib basiclife/BasicTerm_ME semantics · premiums: %s", source), stage = "hard", notes = c(
      sprintf("PV net cash flow %s = premiums %s − claims %s − expenses %s at %.1f%% p.a.; break-even month %s.",
              .sc_comma(pv$net), .sc_comma(pv$premiums), .sc_comma(pv$claims), .sc_comma(pv$expenses), asm$disc_rate * 100, if (is.na(be)) "never" else be),
      sprintf("Makeham q = clamp(A + B·cˣ, 0, 0.95) with A = %s, B = %s, c = %s; lapse %.0f%% p.a.; acquisition %s per policy at issue, maintenance %s per policy-month. Illustrative assumptions, not a priced basis.",
              .sc_repr(asm$mort_A), .sc_repr(asm$mort_B), .sc_repr(asm$mort_c), asm$lapse_rate * 100, .sc_g(asm$expense_acq_pp), .sc_g(asm$expense_maint_pp_mth)),
      if (dropped) sprintf("%d model points dropped (missing or non-positive age / sum assured / term).", dropped) else NULL
    ))
    attr(t, "pv") <- pv
    attr(t, "break_even_month") <- be
    t
  })
}
