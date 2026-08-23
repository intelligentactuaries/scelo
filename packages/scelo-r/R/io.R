# Loading and saving: the soft-data intake, with Scelo's typing rules.
#
# sc_load(path) reads CSV / TSV / TXT (delimiter sniffed) / RDS and applies
# the same cell coercion Scelo IDE applies at import (coerceCsvCell in
# packages/scelo-core): a small set of missing tokens becomes NA, only
# strictly numeric strings become numbers, id-like integers ("007", > 2^53)
# stay strings. Nothing else is touched: cleaning is an explicit, auditable
# step (sc_clean), not something that happens on the way in.

SC_MISSING_CELL_TOKENS <- c("null", "na", "n/a", "nan", "none", "-")
.SC_NUMERIC_STRING_RE <- "^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?$"

#' Scelo's import-time cell rule
#'
#' `""` and the small missing-token set become `NA`; strictly numeric strings
#' become numbers; leading-zero integers ("007") and integers beyond 2^53
#' stay strings; everything else is returned as is.
#' @param x A character vector.
#' @return A list of coerced cells (use [sc_coerce()] for a whole frame).
#' @examples
#' sc_coerce_cell(c(" 42 ", "007", "NA", "1e3", "0x1f"))
#' @export
sc_coerce_cell <- function(x) {
  s <- trimws(as.character(x))
  out <- as.list(s)
  miss <- is.na(s) | s == "" | (nchar(s) <= 4 & tolower(s) %in% SC_MISSING_CELL_TOKENS)
  num <- !miss & grepl(.SC_NUMERIC_STRING_RE, s)
  plain_int <- num & grepl("^[+-]?[0-9]+$", s)
  leading0 <- plain_int & grepl("^[+-]?0[0-9]", s)
  vals <- suppressWarnings(as.numeric(s))
  big <- plain_int & !is.na(vals) & abs(vals) > 2^53 - 1
  keep_str <- leading0 | big
  for (i in which(miss)) out[[i]] <- NA
  for (i in which(num & !keep_str & is.finite(vals))) out[[i]] <- vals[i]
  out
}

.sc_is_text <- function(col) is.character(col) || is.factor(col)

.sc_coerce_column <- function(col) {
  s <- as.character(col)
  cells <- sc_coerce_cell(s)
  is_num <- vapply(cells, is.numeric, logical(1))
  is_na <- vapply(cells, function(v) length(v) == 1 && is.na(v), logical(1))
  if (all(is_na)) return(rep(NA_character_, length(cells)))
  if (all(is_num | is_na)) {
    v <- vapply(cells, function(c) if (is.numeric(c)) c else NA_real_, numeric(1))
    if (all(is.na(v) | v == round(v)) && !any(is.na(v)) && all(abs(v) < .Machine$integer.max)) return(as.integer(v))
    return(v)
  }
  # mixed: keep the numeric cells as numbers inside a list? R columns are typed; keep character but
  # with the coerced strings (trimmed) so the cleaning layer can type it (coerce-numeric).
  vapply(cells, function(c) if (length(c) == 1 && is.na(c)) NA_character_ else as.character(c), character(1))
}

#' Apply Scelo's import coercion to every text column
#'
#' @param df A data frame.
#' @return A data frame with numeric-looking text columns typed as numbers.
#' @export
sc_coerce <- function(df) {
  for (c in names(df)) if (.sc_is_text(df[[c]])) df[[c]] <- .sc_coerce_column(df[[c]])
  df
}

#' Guess a delimiter the way the IDE does
#'
#' Reads the first KB, rejects binary content (NUL bytes, > 2 % control
#' bytes), drops the last (possibly truncated) line, keeps 20 lines and picks
#' the candidate among comma, tab and semicolon whose minimum per-line count is highest.
#' @param path A file.
#' @param nbytes Bytes to inspect.
#' @return A one-character delimiter (comma, tab or semicolon) or `NULL`.
#' @export
sc_sniff <- function(path, nbytes = 1024L) {
  raw <- readBin(path, "raw", nbytes)
  if (!length(raw)) return(NULL)
  b <- as.integer(raw)
  if (any(b == 0L)) return(NULL)
  control <- sum(b < 32L & !(b %in% c(9L, 10L, 13L)))
  if (control / length(b) > 0.02) return(NULL)
  text <- rawToChar(raw[b != 0L])
  Encoding(text) <- "UTF-8"
  lines <- strsplit(text, "\r?\n")[[1]]
  if (length(lines) > 1) lines <- lines[-length(lines)]
  lines <- utils::head(lines[nzchar(trimws(lines))], 20)
  if (!length(lines)) return(NULL)
  best <- NULL
  best_min <- 0L
  for (cand in c(",", "\t", ";")) {
    m <- min(vapply(lines, function(l) lengths(regmatches(l, gregexpr(cand, l, fixed = TRUE))), integer(1)))
    if (m >= 1L && m > best_min) {
      best <- cand
      best_min <- m
    }
  }
  best
}

.sc_dedupe_header <- function(cols) {
  cols <- trimws(cols)
  cols[cols == ""] <- "column"
  out <- cols
  seen <- list()
  for (i in seq_along(cols)) {
    n <- cols[i]
    if (!is.null(seen[[n]])) {
      seen[[n]] <- seen[[n]] + 1L
      out[i] <- paste0(n, "_", seen[[n]])
    } else {
      seen[[n]] <- 1L
    }
  }
  out
}

#' Read a file into a data frame with Scelo's import typing
#'
#' Formats by extension: `.csv` `.tsv` `.txt` (delimiter sniffed) `.rds`.
#' Text is read as character and then typed cell by cell with
#' [sc_coerce_cell()]; headers are trimmed and de-duplicated (`_2`, `_3`).
#' @param path A file.
#' @param rows Keep a uniform reservoir sample of this many rows (the IDE
#'   caps imports at 250 000).
#' @param sep Delimiter override.
#' @param coerce Apply [sc_coerce()] (default `TRUE`).
#' @param seed Seed for the reservoir sample.
#' @param ... Passed to [utils::read.table()].
#' @return A data frame with attributes `name` and `source`.
#' @examples
#' df <- sc_load(system.file("extdata", "claims.csv", package = "scelo"))
#' head(df)
#' @export
sc_load <- function(path, rows = NULL, sep = NULL, coerce = TRUE, seed = NULL, ...) {
  if (!file.exists(path)) stop(sprintf("%s does not exist", path), call. = FALSE)
  ext <- tolower(tools::file_ext(path))
  if (ext == "rds") {
    df <- readRDS(path)
  } else {
    if (is.null(sep)) sep <- switch(ext, tsv = "\t", csv = ",", sc_sniff(path))
    if (is.null(sep)) stop(sprintf("%s does not look like delimited text (binary content, or no consistent delimiter in the first KB): try .csv, .tsv", basename(path)), call. = FALSE)
    df <- utils::read.table(path, sep = sep, header = TRUE, colClasses = "character", na.strings = character(), quote = "\"", comment.char = "",
                            check.names = FALSE, strip.white = FALSE, blank.lines.skip = TRUE, encoding = "UTF-8", fileEncoding = "UTF-8-BOM", stringsAsFactors = FALSE, ...)
    names(df) <- .sc_dedupe_header(names(df))
  }
  if (coerce) df <- sc_coerce(df)
  if (!is.null(rows) && nrow(df) > rows) df <- sc_reservoir(df, rows, seed = seed)
  attr(df, "name") <- basename(path)
  attr(df, "source") <- normalizePath(path)
  .sc_record("sc_load", list(path = path), NULL, df, 0)
  df
}

#' Uniform reservoir sample in original order
#'
#' The IDE's import cap: a uniform sample of `n` rows that keeps the file
#' order, stamped with `sampled`, `sample_kind` and `source_total_rows`.
#' @param df A data frame.
#' @param n Rows to keep.
#' @param seed Seed.
#' @return A data frame.
#' @export
sc_reservoir <- function(df, n, seed = NULL) {
  if (nrow(df) <= n) return(df)
  if (!is.null(seed)) set.seed(seed)
  idx <- sort(sample.int(nrow(df), n))
  out <- df[idx, , drop = FALSE]
  rownames(out) <- NULL
  attr(out, "sampled") <- TRUE
  attr(out, "sample_kind") <- "uniform"
  attr(out, "source_total_rows") <- nrow(df)
  out
}

#' Write a frame by extension
#'
#' `.csv` `.tsv` `.rds` `.json` (needs jsonlite) `.md` `.html`; notes and
#' basis of a `scelo_table` go into `.md` / `.html`. Writes atomically
#' (`<file>.partial` then rename).
#' @param df A data frame or `scelo_table`.
#' @param path Destination.
#' @param ... Passed to the writer.
#' @return The path, invisibly.
#' @export
sc_save <- function(df, path, ...) {
  ext <- tolower(tools::file_ext(path))
  dir.create(dirname(path), showWarnings = FALSE, recursive = TRUE)
  tmp <- paste0(path, ".partial")
  plain <- if (inherits(df, "scelo_table")) sc_df(df) else as.data.frame(df)
  if (ext %in% c("csv", "tsv", "txt")) {
    utils::write.table(plain, tmp, sep = if (ext == "tsv") "\t" else ",", row.names = FALSE, qmethod = "double", na = "", ...)
  } else if (ext == "rds") {
    saveRDS(df, tmp, ...)
  } else if (ext == "json") {
    .sc_need("jsonlite")
    writeLines(jsonlite::toJSON(plain, dataframe = "rows", pretty = TRUE, na = "null", digits = NA), tmp)
  } else if (ext == "md") {
    writeLines(sc_markdown(df), tmp)
  } else if (ext %in% c("html", "htm")) {
    writeLines(.sc_md_to_html(sc_markdown(df)), tmp)
  } else {
    stop(sprintf("unsupported extension '%s'", ext), call. = FALSE)
  }
  file.rename(tmp, path)
  invisible(path)
}

.sc_need <- function(pkg, why = NULL) {
  if (!requireNamespace(pkg, quietly = TRUE)) stop(sprintf("package '%s' is needed%s: install.packages(\"%s\")", pkg, if (is.null(why)) "" else paste0(" ", why), pkg), call. = FALSE)
  invisible(TRUE)
}

.SC_SAMPLES <- data.frame(
  key = c("claims", "climate", "dirty", "wmtr-scenarios", "lifelib-mp", "workspace-demo"),
  title = c("Synthetic claims", "Climate reanalysis ensemble", "Messy intake (dirty demo)", "WMTR forecast scenarios", "Lifelib model points", "Workspace demo"),
  about = c(
    "P&C reserving / pricing demo: 79 rows of an incomplete claims triangle (origins 2018-2024) with policy, line, province, age, sex, paid, incurred, settled.",
    "30 daily records for one grid cell (Pretoria, Jan 2024): 2-m temperature and precipitation under ERA5 / MERRA-2 / JRA-3Q.",
    "53-row customer ledger with every real-world mess: currency strings, %-numbers, sentinel ages, mixed booleans and date formats, mojibake, NBSP / zero-width characters, missing markers, duplicate rows.",
    "12 scenario rows for the W(M, T, R) Monte Carlo forecast: alpha_m / alpha_t / alpha_r, relational weights, shock, horizon.",
    "100-row in-force term-life model-point file shaped like lifelib's basic_term_sample.",
    "2,000-policy synthetic annuity book: three low-variance real drivers acting through nonlinear channels, a crude-rate level, ten high-variance nuisance columns."
  ),
  stringsAsFactors = FALSE
)

#' The bundled sample datasets
#'
#' The same six samples Scelo IDE offers, byte-identical.
#' @return A data frame of key, title, about.
#' @export
sc_samples <- function() .SC_SAMPLES

#' Load a bundled sample
#'
#' @param key One of `claims`, `climate`, `dirty`, `wmtr-scenarios`,
#'   `lifelib-mp`, `workspace-demo`.
#' @param ... Passed to [sc_load()].
#' @return A data frame.
#' @examples
#' head(sc_sample("claims"))
#' @export
sc_sample <- function(key = "claims", ...) {
  k <- gsub("_", "-", tolower(trimws(key)))
  if (!k %in% .SC_SAMPLES$key) stop(sprintf("unknown sample '%s': choose from %s", key, paste(.SC_SAMPLES$key, collapse = ", ")), call. = FALSE)
  df <- sc_load(.sc_extdata(paste0(k, ".csv")), ...)
  attr(df, "name") <- .SC_SAMPLES$title[.SC_SAMPLES$key == k]
  df
}

# Path of a bundled data file: the installed package, or inst/extdata when the
# sources are being run directly (dev/run-tests.R).
.sc_extdata <- function(file) {
  p <- system.file("extdata", file, package = "scelo")
  if (nzchar(p)) return(p)
  for (cand in c(file.path("inst", "extdata", file), file.path("..", "..", "inst", "extdata", file))) if (file.exists(cand)) return(normalizePath(cand))
  stop(sprintf("bundled file %s not found", file), call. = FALSE)
}
