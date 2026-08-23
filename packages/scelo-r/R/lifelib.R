# lifelib: run the pinned lifelib models Scelo IDE ships, from R.
#
# Scelo's life family is rooted in lifelib (lifelib 0.14.0 / modelx 0.32.0,
# the pair the IDE bundles and verifies). lifelib is a Python library with
# no R port, so sc_lifelib_run() drives it through reticulate when that is
# installed and lifelib / modelx import; without them it stops with the
# install instructions instead of pretending. sc_lifelib_models() lists the
# libraries and their status; sc_normalise_model_points() maps any policy
# file onto lifelib's model-point columns, the same mapping the Python
# package and the IDE apply; sc_lifelib_run("basiclife", "BasicTerm_ME",
# model_points) copies the library into $SCELO_LIFELIB_HOME (or
# ~/.cache/scelo/lifelib) the first time, reads the model with modelx, sets
# the model-point table and returns the cash flows.

#' The lifelib and modelx versions Scelo targets
#'
#' The pair Scelo IDE bundles and verifies; [sc_lifelib_run()] warns when a
#' different lifelib is installed.
#' @format A string.
#' @export
SC_LIFELIB_VERSION <- "0.14.0"

#' @rdname SC_LIFELIB_VERSION
#' @format A string.
#' @export
SC_MODELX_VERSION <- "0.32.0"

.SC_LIFELIB_LIBRARIES <- data.frame(
  library = c("basiclife", "savings", "annuallife", "uslib", "ifrs17a", "smithwilson", "cluster", "economic", "economic_curves", "appliedlife", "assets", "ifrs17sim", "solvency2", "nestedlife", "simplelife", "fastlife"),
  status = c("active", "active", "active", "draft", "active", "active", "active", "active", "active", "active", "active", "legacy", "legacy", "legacy", "legacy", "legacy"),
  models = c(
    "BasicTerm_M, BasicTerm_ME, BasicTerm_S, BasicTerm_SE, BasicTerm_SC, BasicTermASL_ME",
    "CashValue_ME, CashValue_ME_EX1, CashValue_ME_EX2, CashValue_ME_EX4, CashValue_SE",
    "TradLife_A, TradLife_A_EX1, TradLife_A_mx30",
    "term_life, whole_life, universal_life, … variable_annuity",
    "ifrs17 (package), template.py",
    "model",
    "cluster_model_points.ipynb, BasicTerm_ME_for_Cluster",
    "BasicHullWhite",
    "smith_wilson, NelsonSiegelSvensson, bisection_alpha, stationary_bootstrap",
    "IntegratedLife",
    "BasicBonds",
    "OuterProj, InnerProj",
    "SCR_life",
    "OuterProj, InnerProj",
    "Projection",
    "Projection"
  ),
  note = c(
    "Monthly / seriatim term-life projections on a model-point table.",
    "Account-value roll-forward with crediting, COI, surrender charges.",
    "Per-policy annual traditional-life projection; EX1 adds Solvency II life SCR.",
    "Twelve U.S. individual life & annuity reference models (draft in 0.14.0).",
    "IFRS 17 measurement engine driven from nominal cash flows and yield curves.",
    "EIOPA Smith-Wilson risk-free curve extrapolation.",
    "k-means model-point compression preserving liability sensitivity.",
    "Hull-White short-rate Monte Carlo.",
    "Curve algorithms as standalone scripts.",
    "Multi-product projection model with a run-and-report harness.",
    "Bond-portfolio cash flows and valuation.",
    "CSM roll-forward on simplelife (deprecated 0.12.0; successor ifrs17a).",
    "Standard-formula life SCR on simplelife (deprecated 0.13.0; successor annuallife).",
    "Nested projection on simplelife (deprecated 0.12.0).",
    "The original annual projection (deprecated 0.12.0; successor annuallife).",
    "Vectorised simplelife (deprecated 0.12.0)."
  ),
  stringsAsFactors = FALSE
)

.SC_MP_ALIASES <- list(
  policy_id = c("policy_id", "policyid", "policy", "id", "model_point_id", "mp_id", "point_id"),
  age_at_entry = c("age_at_entry", "ageatentry", "issue_age", "issueage", "age"),
  sex = c("sex", "gender"),
  sum_assured = c("sum_assured", "sumassured", "sa", "face_amount", "face", "benefit", "sum_insured"),
  policy_term = c("policy_term", "policyterm", "term", "term_years", "policy_term_years"),
  duration_mth = c("duration_mth", "durationmth", "duration_months", "duration", "dur_mth", "elapsed_mth"),
  premium_pp = c("premium_pp", "premiumpp", "premium", "monthly_premium", "prem", "annual_premium", "premium_pp_pa"),
  policy_count = c("policy_count", "policycount", "count", "lives", "weight"),
  account_value = c("account_value", "av", "av_pp_init", "acct_value", "fund_value"),
  product = c("product", "product_type", "plan")
)

#' The lifelib libraries Scelo targets
#'
#' One row per library with its status (active / legacy / draft), headline
#' models and a one-line note.
#' @return A data frame with `library`, `status`, `models`, `note`.
#' @examples
#' sc_lifelib_models()[, c("library", "status")]
#' @export
sc_lifelib_models <- function() .SC_LIFELIB_LIBRARIES

#' Provenance string of a lifelib model
#'
#' "lifelib 0.14.0 · basiclife / BasicTerm_ME", the string the IDE prints on
#' its result cards ("(legacy)" appended for the deprecated libraries).
#' @param library A lifelib library name.
#' @param model A model in it.
#' @return A string.
#' @examples
#' sc_lifelib_provenance("basiclife", "BasicTerm_ME")
#' @export
sc_lifelib_provenance <- function(library, model) {
  status <- .SC_LIFELIB_LIBRARIES$status[match(library, .SC_LIFELIB_LIBRARIES$library)]
  paste0(sprintf("lifelib %s · %s / %s", SC_LIFELIB_VERSION, library, model), if (identical(status, "legacy")) " (legacy)" else "")
}

#' Where lifelib libraries are copied
#'
#' `$SCELO_LIFELIB_HOME` (the IDE sets it), else `~/.cache/scelo/lifelib`
#' (`%LOCALAPPDATA%/scelo/lifelib` on Windows), with the lifelib version as
#' the last path element.
#' @return A path (not necessarily existing).
#' @examples
#' sc_lifelib_home()
#' @export
sc_lifelib_home <- function() {
  base <- Sys.getenv("SCELO_LIFELIB_HOME", unset = "")
  if (!nzchar(base)) {
    root <- if (.Platform$OS.type == "windows") Sys.getenv("LOCALAPPDATA", unset = "") else path.expand("~/.cache")
    base <- if (nzchar(root)) file.path(root, "scelo", "lifelib") else file.path("scelo", "lifelib")
  }
  file.path(base, SC_LIFELIB_VERSION)
}

#' Map a policy file onto lifelib's model-point columns
#'
#' `policy_id`, `age_at_entry`, `sex`, `sum_assured`, `policy_term`,
#' `duration_mth`, `premium_pp`, `policy_count` (plus `account_value` and
#' `product` when present), found by exact lower-case alias. Sex becomes
#' M / F; duration defaults to 0 and policy_count to 1; rows missing age /
#' sum assured / term (or with non-positive values) are dropped; duplicate
#' ids get a `#k` suffix.
#'
#' @param df A policy file.
#' @return A data frame with `policy_id` first.
#' @examples
#' head(sc_normalise_model_points(sc_sample("lifelib-mp")))
#' @export
sc_normalise_model_points <- function(df) {
  lower <- stats::setNames(names(df), tolower(names(df)))
  out <- list()
  for (key in names(.SC_MP_ALIASES)) {
    hit <- .SC_MP_ALIASES[[key]][.SC_MP_ALIASES[[key]] %in% names(lower)][1]
    if (!is.na(hit)) out[[key]] <- df[[lower[[hit]]]]
  }
  n <- nrow(df)
  if (is.null(out$policy_id)) out$policy_id <- sprintf("MP%05d", seq_len(n))
  for (c in c("age_at_entry", "sum_assured", "policy_term", "duration_mth", "premium_pp", "policy_count", "account_value")) if (!is.null(out[[c]])) out[[c]] <- .sc_to_num(out[[c]])
  out$sex <- if (!is.null(out$sex)) ifelse(tolower(trimws(as.character(out$sex))) %in% c("f", "female", "w", "woman", "2"), "F", "M") else rep("M", n)
  out$duration_mth <- if (!is.null(out$duration_mth)) { v <- out$duration_mth; v[is.na(v)] <- 0; as.integer(v) } else rep(0L, n)
  out$policy_count <- if (!is.null(out$policy_count)) { v <- out$policy_count; v[is.na(v)] <- 1; v } else rep(1, n)
  need <- intersect(c("age_at_entry", "sum_assured", "policy_term"), names(out))
  if (length(need) < 3) stop("a model-point file needs age_at_entry, sum_assured and policy_term columns", call. = FALSE)
  out <- as.data.frame(out, stringsAsFactors = FALSE, check.names = FALSE)
  keep <- !is.na(out$age_at_entry) & !is.na(out$sum_assured) & !is.na(out$policy_term)
  keep <- keep & out$age_at_entry > 0 & out$sum_assured > 0 & out$policy_term > 0
  out <- out[keep, , drop = FALSE]
  out$age_at_entry <- as.integer(out$age_at_entry)
  out$policy_term <- as.integer(out$policy_term)
  ids <- as.character(out$policy_id)
  if (anyDuplicated(ids)) {
    k <- stats::ave(seq_along(ids), ids, FUN = seq_along) - 1L
    ids <- paste0(ids, ifelse(k > 0, paste0("#", k), ""))
  }
  out$policy_id <- ids
  out <- out[, c("policy_id", setdiff(names(out), "policy_id")), drop = FALSE]
  rownames(out) <- NULL
  out
}

.SC_LIFELIB_HOW <- paste0("lifelib is a Python library: sc_lifelib_run() needs the reticulate package pointed at a Python with lifelib and modelx installed ",
                          "(install.packages(\"reticulate\"); pip install \"scelo[life]\", which pins lifelib==", SC_LIFELIB_VERSION, " and modelx==", SC_MODELX_VERSION, "). ",
                          "sc_basicterm() is the base-R BasicTerm_ME projection that needs no Python.")

.sc_require_lifelib <- function() {
  if (!requireNamespace("reticulate", quietly = TRUE)) stop(paste0("package 'reticulate' is not installed. ", .SC_LIFELIB_HOW), call. = FALSE)
  want <- Sys.getenv("SCELO_LIFELIB_PYTHON", unset = "")
  if (nzchar(want) && !isTRUE(reticulate::py_available(initialize = FALSE))) reticulate::use_python(want, required = TRUE)
  ok <- tryCatch(reticulate::py_module_available("lifelib") && reticulate::py_module_available("modelx"), error = function(e) FALSE)
  if (!ok) stop(paste0("lifelib / modelx are not installed: pip install scelo[life] (pins lifelib==", SC_LIFELIB_VERSION, ", modelx==", SC_MODELX_VERSION, "). ", .SC_LIFELIB_HOW), call. = FALSE)
  lifelib <- reticulate::import("lifelib", convert = FALSE)
  mx <- reticulate::import("modelx", convert = FALSE)
  version <- tryCatch(as.character(reticulate::py_to_r(reticulate::py_get_attr(lifelib, "__version__"))), error = function(e) "?")
  if (!identical(version, SC_LIFELIB_VERSION)) warning(sprintf("lifelib %s installed, Scelo targets %s", version, SC_LIFELIB_VERSION), call. = FALSE)
  list(lifelib = lifelib, mx = mx, version = version)
}

# A pandas DataFrame as a plain data.frame; columns reticulate leaves as Python
# objects (pandas 3 Arrow-backed strings) are finished off via tolist().
.sc_py_frame <- function(pdf) {
  df <- reticulate::py_to_r(pdf)
  for (c in names(df)) {
    if (inherits(df[[c]], "python.builtin.object")) {
      df[[c]] <- tryCatch(unlist(reticulate::py_to_r(df[[c]]$tolist())), error = function(e) as.character(reticulate::py_to_r(df[[c]]$astype("str")$tolist())))
    }
  }
  rownames(df) <- NULL
  df
}

.sc_library_dir <- function(lifelib, library) {
  home <- sc_lifelib_home()
  dest <- file.path(home, library)
  if (dir.exists(dest)) return(dest)
  dir.create(home, recursive = TRUE, showWarnings = FALSE)
  tmp <- tempfile(pattern = paste0(library, "-"), tmpdir = home)
  dir.create(tmp)
  target <- file.path(tmp, library)
  lifelib$create(library, target)
  if (!file.rename(target, dest)) stop(sprintf("could not move %s into %s", target, dest), call. = FALSE)
  unlink(tmp, recursive = TRUE)
  dest
}

#' Run a lifelib model on a model-point file
#'
#' Reads `library/model` with modelx (copying the library into
#' [sc_lifelib_home()] the first time), sets the model-point table and
#' returns the aggregate cash flows (`result_cf()`), with the per-policy
#' present values (`result_pv()`, ids in the first column) in the `pv`
#' attribute, run metadata in
#' `meta` and the live modelx model in `model`. Works for the
#' model-point-driven models (basiclife BasicTerm_*, savings CashValue_*);
#' for other libraries it returns whatever `space.result_cf()` /
#' `result_pv()` give, or stops with a pointer to the model's own API.
#'
#' lifelib has no R implementation: this needs the `reticulate` package
#' and a Python with lifelib and modelx (`pip install "scelo[life]"`).
#' Without them the function stops and says so; [sc_basicterm()] is the
#' base-R projection that needs no Python.
#'
#' @param library A lifelib library (see [sc_lifelib_models()]).
#' @param model A model in it.
#' @param model_points A policy / model-point file (mapped with
#'   [sc_normalise_model_points()]); `NULL` runs the model's own table.
#' @param space The modelx space holding `result_cf()` / `result_pv()`.
#' @param premium_from_file Use the file's `premium_pp` (when present)
#'   instead of lifelib's premium table.
#' @return A `scelo_table` of cash flows by `t`, with attributes `pv`
#'   (data frame), `meta` (list) and `model` (the modelx model).
#' @examples
#' \dontrun{
#' cf <- sc_lifelib_run("basiclife", "BasicTerm_ME", sc_sample("lifelib-mp"))
#' attr(cf, "pv")
#' }
#' @export
sc_lifelib_run <- function(library = "basiclife", model = "BasicTerm_ME", model_points = NULL, space = "Projection", premium_from_file = TRUE) {
  .sc_tool("sc_lifelib_run", .sc_args(library = library, model = model, space = space, premium_from_file = premium_from_file), model_points, {
    py <- .sc_require_lifelib()
    lifelib <- py$lifelib
    mx <- py$mx
    pd <- reticulate::import("pandas", convert = FALSE)
    lib_dir <- .sc_library_dir(lifelib, library)
    # re-reading a model renames the old one with a warning; close it instead
    existing <- reticulate::py_to_r(reticulate::import_builtins()$list(mx$get_models()$values()))
    for (old in existing) if (identical(as.character(reticulate::py_to_r(reticulate::py_get_attr(old, "name"))), model)) old$close()
    m <- mx$read_model(file.path(lib_dir, model))
    P <- reticulate::py_get_attr(m, space)
    meta <- list(library = library, model = model, lifelib = py$version,
                 modelx = tryCatch(as.character(reticulate::py_to_r(reticulate::py_get_attr(mx, "__version__"))), error = function(e) "?"))
    if (!is.null(model_points)) {
      mp <- sc_normalise_model_points(model_points)
      cols <- intersect(c("age_at_entry", "sex", "policy_term", "policy_count", "sum_assured", "duration_mth"), names(mp))
      table <- mp[, cols, drop = FALSE]
      has_prem <- "premium_pp" %in% names(mp) && premium_from_file
      if (has_prem) {
        v <- as.numeric(mp$premium_pp)
        v[is.na(v)] <- 0
        table$premium_pp <- v
      }
      py_table <- reticulate::r_to_py(table)
      reticulate::py_set_attr(py_table, "index", pd$Index(as.list(mp$policy_id), name = "policy_id"))
      reticulate::py_set_attr(P, "model_point_table", py_table)
      if (has_prem) {
        if (reticulate::py_has_attr(P, "premium_pp")) reticulate::py_set_attr(reticulate::py_get_attr(P, "premium_pp"), "formula", "def premium_pp():\n    return model_point()['premium_pp']")
        meta$premium_source <- "model-point file"
      } else {
        meta$premium_source <- "lifelib premium table"
      }
      meta$model_points <- nrow(table)
    }
    res <- tryCatch(list(pv = P$result_pv(), cf = P$result_cf()), error = function(e) e)
    if (inherits(res, "error")) {
      if (grepl("AttributeError", conditionMessage(res), fixed = TRUE)) {
        stop(sprintf("%s/%s space %s has no result_cf()/result_pv(): drive it through modelx directly (m = mx$read_model(...))", library, model, space), call. = FALSE)
      }
      stop(conditionMessage(res), call. = FALSE)
    }
    cf <- pd$DataFrame(res$cf)
    reticulate::py_set_attr(reticulate::py_get_attr(cf, "index"), "name", "t")
    cf_df <- .sc_py_frame(cf$reset_index())
    pv_df <- .sc_py_frame(pd$DataFrame(res$pv)$reset_index())
    pv_note <- if ("Net Cashflow" %in% names(pv_df)) sprintf("PV net cash flow %s.", .sc_comma(sum(as.numeric(pv_df[["Net Cashflow"]]), na.rm = TRUE))) else "See attr(x, \"pv\") for the per-policy present values."
    t <- sc_table(cf_df, title = sprintf("%s / %s · %s model points", library, model, if (is.null(meta$model_points)) "?" else meta$model_points),
                  basis = sc_lifelib_provenance(library, model), stage = "hard", notes = c(
      sprintf("lifelib %s · modelx %s · premiums from %s.", meta$lifelib, meta$modelx, if (is.null(meta$premium_source)) "model" else meta$premium_source),
      pv_note
    ))
    attr(t, "pv") <- pv_df
    attr(t, "meta") <- meta
    attr(t, "model") <- m
    t
  })
}
