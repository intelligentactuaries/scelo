# The audit trail: what the tools layer did, in order.
#
# Scelo's pipeline rule is that hard data never travels without the trail
# that produced it. Every tools function records one entry here (function,
# the arguments that matter, input / output shapes and content hashes,
# elapsed time). sc_audit() returns the trail; sc_hard() copies the relevant
# entries onto the table it stamps.

.sc_env <- new.env(parent = emptyenv())
.sc_env$trail <- list()
.sc_env$enabled <- TRUE

#' Content hash of a value
#'
#' MD5 of the serialised content (not the identity) of a data frame, vector
#' or scalar, via [tools::md5sum()] so no package is needed.
#' @param x Anything.
#' @return A 32-character hex string.
#' @export
sc_content_hash <- function(x) {
  f <- tempfile()
  on.exit(unlink(f))
  if (is.data.frame(x)) {
    utils::write.csv(as.data.frame(x), f, row.names = FALSE)
  } else {
    writeLines(paste(format(x, digits = 15), collapse = ","), f)
  }
  unname(tools::md5sum(f))
}

.sc_shape <- function(x) {
  if (is.data.frame(x)) sprintf("%d×%d", nrow(x), ncol(x)) else if (is.atomic(x) && length(x) > 1) as.character(length(x)) else NA_character_
}

.sc_record <- function(fn, args, input, output, ms, note = "") {
  entry <- list(
    at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S", tz = "UTC"),
    fn = fn,
    args = paste(vapply(names(args), function(n) {
      v <- args[[n]]
      if (is.data.frame(v) || (is.atomic(v) && length(v) > 12)) sprintf("%s=<%s %s>", n, class(v)[1], .sc_shape(v)) else if (is.atomic(v)) sprintf("%s=%s", n, paste(format(v), collapse = "/")) else sprintf("%s=<%s>", n, class(v)[1])
    }, character(1)), collapse = ", "),
    `in` = if (!is.null(input)) substr(sc_content_hash(input), 1, 16) else NA_character_,
    in_shape = if (!is.null(input)) .sc_shape(input) else NA_character_,
    out = if (!is.null(output)) substr(sc_content_hash(output), 1, 16) else NA_character_,
    out_shape = if (!is.null(output)) .sc_shape(output) else NA_character_,
    ms = round(ms, 2),
    scelo = .sc_version(),
    note = note
  )
  if (isTRUE(.sc_env$enabled)) .sc_env$trail[[length(.sc_env$trail) + 1L]] <- entry
  invisible(entry)
}

# Run `expr` as a tool: time it, hash the first data-frame argument and the
# result, log it. Used inside every exported tools function.
.sc_tool <- function(fn, args, input, expr) {
  t0 <- proc.time()[["elapsed"]]
  out <- expr
  ms <- (proc.time()[["elapsed"]] - t0) * 1000
  if (isTRUE(.sc_env$enabled)) {
    hashed <- if (is.data.frame(out)) out else if (is.list(out) && is.data.frame(out$table)) out$table else NULL
    .sc_record(fn, args, input, hashed, ms)
  }
  out
}

#' The audit trail
#'
#' Everything the tools layer did this session, most recent last.
#' @param last Keep only the last `n` entries.
#' @return A data frame with `at`, `fn`, `args`, `in`, `in_shape`, `out`,
#'   `out_shape`, `ms`, `scelo`, `note`.
#' @examples
#' sc_clear_audit(); sc_life_table(); sc_audit()
#' @export
sc_audit <- function(last = NULL) {
  tr <- .sc_env$trail
  if (!is.null(last)) tr <- utils::tail(tr, last)
  if (!length(tr)) return(data.frame(at = character(), fn = character(), args = character(), `in` = character(), in_shape = character(), out = character(), out_shape = character(), ms = numeric(), scelo = character(), note = character(), check.names = FALSE))
  do.call(rbind, lapply(tr, function(e) as.data.frame(e, stringsAsFactors = FALSE, check.names = FALSE)))
}

#' @rdname sc_audit
#' @export
sc_clear_audit <- function() {
  .sc_env$trail <- list()
  invisible(NULL)
}

#' @rdname sc_audit
#' @param on `TRUE` to record (the default), `FALSE` to switch recording off.
#' @export
sc_enable_audit <- function(on = TRUE) {
  .sc_env$enabled <- isTRUE(on)
  invisible(on)
}

.sc_version <- function() tryCatch(as.character(utils::packageVersion("scelo")), error = function(e) "0.1.0")
