# One-liners: whole workflows as single calls, Stata-style.
#
# sc_reserve("claims.csv") (in reserving.R), sc_experience("deaths.csv"),
# sc_price("policies.csv", "claims ~ C(region)") and sc_quick("file") each
# run a complete, audited chain and hand back hard tables. They add no
# maths of their own: every step is one of the tools functions, so the
# audit trail shows the chain and the caveats of each step travel with the
# result (the graduation and the life table ride as attributes of the A/E
# table, the models as attributes of the relativities).

.sc_frame <- function(x) if (is.data.frame(x)) x else sc_load(x)

.sc_formula_string <- function(formula) {
  if (inherits(formula, "formula")) paste(deparse(formula, width.cutoff = 500L), collapse = " ") else as.character(formula)
}

#' Mortality experience study in one line
#'
#' A/E by age band against a basis, Whittaker-Henderson graduated crude
#' rates, and the resulting life table. `data` needs age + deaths + exposure
#' columns (inferred, or pass `age = `, `deaths = `, `exposure = `). Returns
#' the A/E table with the graduated qx in `attr(, "graduated")` and the life
#' table in `attr(, "life_table")`.
#' @param data A data frame or a file path.
#' @param expected The expected basis (see [sc_ae()]); the illustrative Makeham when `NULL`.
#' @param h Whittaker-Henderson smoothing parameter.
#' @param band Age-band width.
#' @param age,deaths,exposure Column names, inferred when `NULL`.
#' @return A `scelo_table` (the A/E table) with attributes `graduated` and `life_table`.
#' @examples
#' x <- data.frame(age = rep(40:79, each = 2), deaths = rep(c(1, 2), 40), exposure = 500)
#' e <- sc_experience(x)
#' attr(e, "life_table")$ex[1]
#' @export
sc_experience <- function(data, expected = NULL, h = 100, band = 5, age = NULL, deaths = NULL, exposure = NULL) {
  df <- .sc_frame(data)
  .sc_tool("sc_experience", Filter(Negate(is.null), list(expected = if (is.data.frame(expected)) "<data.frame>" else expected, h = h, band = band)), df, {
    a <- sc_infer(df, "age", age)
    d <- sc_infer(df, "deaths", deaths, exclude = a)
    e <- sc_infer(df, "exposure", exposure, exclude = c(a, d))
    aet <- sc_ae(df, expected, age = a, deaths = d, exposure = e, band = band)
    sub <- df[c(a, d, e)]
    names(sub) <- c("age", "deaths", "exposure")
    g <- sc_graduate(sub, h = h)
    gq <- stats::setNames(g$graduated, g$age)
    lt <- sc_life_table(gq)
    aet <- sc_note(aet, sprintf("Graduated crude rates (WH h=%g) and the life table on them sit in attr(, \"graduated\") / attr(, \"life_table\"); e(%d) = %.2f on the graduated basis.",
                                h, as.integer(lt$age[1]), lt$ex[1]))
    attr(aet, "graduated") <- g
    attr(aet, "life_table") <- lt
    aet
  })
}

#' Frequency (and severity) GLM pricing in one line
#'
#' `sc_price(df, "claims ~ C(region) + age", offset = "exposure", severity = "paid")`
#' fits Poisson frequency and Gamma severity on the same right-hand side and
#' multiplies the relativities into a pure-premium table, with the models
#' as attributes.
#' @param data A data frame or a file path.
#' @param formula The frequency formula (a string or a formula).
#' @param family Frequency family.
#' @param offset Exposure column entering as `log(offset)`.
#' @param severity Claim-amount column for the Gamma severity model (`NULL`: frequency only).
#' @param by Grouping column(s) for the frequency-severity summary in `attr(, "summary")`.
#' @return A `scelo_table` of `factor`, `level`, `frequency` (and `severity`,
#'   `pure_premium`) with attributes `frequency`, `severity` (the models) and `summary`.
#' @examples
#' claims <- sc_sample("claims")
#' claims$n <- as.integer(claims$paid > 20000)
#' p <- sc_price(claims, "n ~ C(line)")
#' p$frequency
#' @export
sc_price <- function(data, formula, family = "poisson", offset = NULL, severity = NULL, by = NULL) {
  df <- .sc_frame(data)
  formula <- .sc_formula_string(formula)
  .sc_tool("sc_price", Filter(Negate(is.null), list(formula = formula, family = family, offset = offset, severity = severity, by = by)), df, {
    freq <- sc_glm(df, formula, family, offset = offset)
    rel <- sc_relativities(freq)
    out <- sc_df(rel)
    names(out)[names(out) == "relativity"] <- "frequency"
    sev_model <- NULL
    basis <- sprintf("frequency %s base %.4g", family, attr(rel, "base_rate"))
    if (!is.null(severity)) {
      rhs <- sub("^[^~]*~", "", formula)
      amount <- suppressWarnings(as.numeric(df[[severity]]))
      sev_model <- sc_glm(df[!is.na(amount) & amount > 0, , drop = FALSE], paste0(severity, " ~", rhs), "gamma")
      srel <- sc_relativities(sev_model)
      sd <- sc_df(srel)
      out$severity <- sd$relativity[match(paste(out$factor, out$level, sep = "\r"), paste(sd$factor, sd$level, sep = "\r"))]
      out$pure_premium <- out$frequency * out$severity
      basis <- paste0(basis, sprintf(" · severity gamma base %.4g", attr(srel, "base_rate")))
    }
    out$estimate <- NULL
    t <- sc_table(out, title = sprintf("Pricing relativities · %s", formula), basis = basis, stage = "hard",
                  notes = "Relativities multiply: rate = base × Π relativity(level). Base levels are the most frequent level of each factor.")
    attr(t, "frequency") <- freq
    attr(t, "severity") <- sev_model
    attr(t, "summary") <- if (!is.null(by) || !is.null(severity)) sc_freq_sev(df, by, count = trimws(sub("~.*$", "", formula)), amount = severity, exposure = offset) else NULL
    t
  })
}

#' Load, profile and describe in one go
#'
#' What is in this file and what it needs: the profile with the cleaning
#' plan in `attr(, "plan")` and the descriptive report in `attr(, "describe")`.
#' @param data A data frame or a file path.
#' @return A `scelo_table` (the profile) with attributes `plan` and `describe`.
#' @examples
#' q <- sc_quick(sc_sample("dirty"))
#' nrow(attr(q, "plan"))
#' @export
sc_quick <- function(data) {
  df <- .sc_frame(data)
  p <- sc_profile(df)
  d <- tryCatch(sc_describe(df), error = function(e) NULL)
  plan <- sc_suggest(df)
  p <- sc_note(p, sprintf("Cleaning plan: %d op(s) (%d safe); see attr(, \"plan\").", nrow(plan), if (nrow(plan)) sum(plan$safe, na.rm = TRUE) else 0L))
  if (!is.null(d) && nrow(d) && any(!is.na(d$cv))) p <- sc_note(p, sprintf("Widest relative spread: `%s` (CV %.2f).", d$column[1], d$cv[1]))
  attr(p, "plan") <- plan
  attr(p, "describe") <- d
  p
}

#' The one-screen cheat-sheet
#'
#' @format `SC_CHEATSHEET`: a single string; `sc_cheatsheet()` prints it.
#' @return `sc_cheatsheet()` returns the text invisibly.
#' @examples
#' sc_cheatsheet()
#' @export
SC_CHEATSHEET <- paste(c(
  "scelo · soft data → tools → hard data                 library(scelo)",
  "──────────────────────────────────────────────────────────────────────────",
  "SOFT    df <- sc_load(\"x.csv\")      sc_profile(df)   sc_describe(df)   sc_tab(df, \"line\")",
  "        sc_suggest(df)              sc_clean(df)     sc_clean(df, \"all\")  sc_combine(a, b)",
  "TOOLS   life      sc_life_table()  sc_commutation(i = .04)  sc_factors(i = .04, n = 10)  sc_premium()",
  "                  sc_ae(df)  sc_ae_test(a, e)  sc_graduate(qx)  sc_lee_carter(df)  sc_kaplan_meier(df)  sc_basicterm(mp)",
  "                  sc_epv(cf, x, i = .04)  sc_mx_to_qx(m)  sc_exposure(df, \"start\", \"end\")",
  "        reserving sc_triangle(df)  sc_chain_ladder(tri)  sc_mack(tri)  sc_bf(tri)  sc_bootstrap(tri)",
  "                  sc_reserve(\"claims.csv\")",
  "        finance   sc_discount_curve(.04)  sc_smith_wilson(t, r)  sc_pv(cf, .05)  sc_irr(cf)  sc_annuity_certain(10, .05)",
  "                  sc_nominal(i, 12)  sc_force(i)  sc_duration(cf, i)  sc_bond_price(100, .05, 10, .06)",
  "        risk      sc_var(x)  sc_tvar(x)  sc_aggregate_loss(\"poisson\", \"lognormal\", lam = 5, mu = 8, sigma = 1)",
  "                  sc_fit(x)  sc_credibility(df, \"group\", \"lr\")  sc_aggregate_scr(list(...))  sc_risk_margin(scr, .04)",
  "        pricing   sc_glm(df, \"claims ~ C(region)+age\", \"poisson\", offset = \"exposure\")  sc_relativities(m)",
  "                  sc_freq_sev(df, \"region\")  sc_loss_ratio(df, \"line\")  sc_lift(y, pred)",
  "        fairness  sc_fairness(df, \"y\", \"score\", \"group\")  sc_fairness_audit(df, \"score\", \"prot\", \"age\")",
  "        climate   sc_ensemble(df, \"t2m\")  sc_return_period(x)  sc_parametric_trigger(x)",
  "        forecast  sc_wmtr(\"pension scheme, weakening covenant\")  sc_sensitivity(...)",
  "        swarm     sc_council(\"…\")  sc_society(\"…\")  sc_augment(df, \"…\")   (needs Scelo IDE / bun run dev:swarm)",
  "HARD    sc_hard(t)  sc_report(t1, t2, to = \"pack.html\")  sc_export(t, \"out.csv\")  sc_audit()  sc_verify(t)",
  "        sc_experience(\"deaths.csv\")  sc_price(df, \"claims ~ C(region)\")  sc_quick(\"file\")   ← whole workflows, one call",
  ""
), collapse = "\n")

#' @rdname SC_CHEATSHEET
#' @export
sc_cheatsheet <- function() {
  cat(SC_CHEATSHEET)
  invisible(SC_CHEATSHEET)
}
