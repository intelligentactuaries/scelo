# Hard data: stamping, reporting, exporting.
#
# A hard number is one that can be defended: it carries what produced it.
# sc_hard(table) stamps a scelo_table with a content hash, the time, the
# scelo version and the audit entries that led to it; sc_report(...) writes
# a board-pack (Markdown or HTML) from any number of tables with their notes
# and provenance; sc_export() writes one table to a file; sc_provenance()
# reads the stamp back; sc_audit() is the trail itself. Snapshots are the
# soft-data undo stack on disk (~/.scelo/snapshots, or $SCELO_HOME), kept as
# RDS with a small JSON sidecar so the Python package lists them too.

.sc_now_iso <- function() format(Sys.time(), "%Y-%m-%dT%H:%M:%S+00:00", tz = "UTC")

#' Stamp a table as hard data
#'
#' Content hash, timestamp, scelo and R versions, the last 12 audit entries
#' and an optional assumption set travel with the table from here on
#' (`sc_provenance()` reads them back, `sc_verify()` checks the hash).
#' @param table A data frame or `scelo_table`.
#' @param title Title to set (keeps the table's own when `NULL`).
#' @param basis Basis line to set.
#' @param note A note to append.
#' @param assumptions A named list recorded in the stamp.
#' @return The `scelo_table`, stage `"hard"`, with a `provenance` attribute:
#'   `hash`, `at`, `scelo`, `r`, `rows`, `columns`, `trail`, `assumptions`.
#' @examples
#' t <- sc_hard(data.frame(x = 1:3), title = "three rows", assumptions = list(i = 0.04))
#' sc_provenance(t)$hash
#' sc_verify(t)
#' @export
sc_hard <- function(table, title = NULL, basis = NULL, note = NULL, assumptions = NULL) {
  t <- if (inherits(table, "scelo_table")) table else sc_table(table, title = title, basis = basis, stage = "hard")
  if (!is.null(title)) attr(t, "title") <- title
  if (!is.null(basis)) attr(t, "basis") <- basis
  if (!is.null(note)) t <- sc_note(t, note)
  trail <- utils::tail(.sc_env$trail, 12)
  prov <- list(
    hash = sc_content_hash(sc_df(t)),
    at = .sc_now_iso(),
    scelo = .sc_version(),
    r = paste(R.version$major, R.version$minor, sep = "."),
    rows = nrow(t),
    columns = names(t),
    trail = lapply(trail, function(e) list(fn = e$fn, at = e$at, `in` = e$`in`, out = e$out))
  )
  if (!is.null(assumptions)) prov$assumptions <- as.list(assumptions)
  attr(t, "provenance") <- prov
  attr(t, "stage") <- "hard"
  t
}

#' Provenance of a hard table
#'
#' The stamp [sc_hard()] wrote (an empty list when the table was never stamped).
#' @param table Any object.
#' @return A list.
#' @examples
#' sc_provenance(sc_hard(data.frame(x = 1)))$rows
#' @export
sc_provenance <- function(table) {
  p <- attr(table, "provenance")
  if (is.null(p)) list() else as.list(p)
}

#' Verify a hard table
#'
#' `TRUE` when a stamped table's content still hashes to its provenance hash
#' (it has not been edited since).
#' @param table A `scelo_table`.
#' @return `TRUE` or `FALSE`.
#' @examples
#' t <- sc_hard(data.frame(x = 1:3))
#' sc_verify(t)
#' t$x[1] <- 9
#' sc_verify(t)
#' @export
sc_verify <- function(table) {
  p <- sc_provenance(table)
  length(p) > 0 && !is.null(p$hash) && identical(sc_content_hash(sc_df(table)), p$hash)
}

#' Export a table
#'
#' Write a table by extension (`.csv` `.tsv` `.rds` `.json` `.md` `.html`);
#' notes and provenance go with `.md` / `.html`. The same as [sc_save()].
#' @param table A data frame or `scelo_table`.
#' @param path Destination.
#' @param ... Passed to the writer.
#' @return The path, invisibly.
#' @examples
#' p <- sc_export(sc_hard(data.frame(x = 1:3)), file.path(tempdir(), "x.csv"))
#' file.exists(p)
#' @export
sc_export <- function(table, path, ...) sc_save(table, path, ...)

.sc_md_block <- function(t) sc_markdown(t)

#' Assemble a board pack
#'
#' A report from tables (and free-text sections given as strings): title,
#' generated line, optional executive summary, every table with its basis,
#' notes and provenance line, the audit trail and a footer. Returns
#' Markdown; writes HTML when `to` ends in `.html`. Unstamped tables are
#' stamped first when `stamp` is `TRUE`.
#' @param ... Tables (`scelo_table`, data frames, or Scelo results carrying a
#'   `$table`) and strings (Markdown sections).
#' @param title Report title.
#' @param to File to write (`.md`, or `.html` / `.htm` for HTML).
#' @param summary Executive summary text.
#' @param author Author line.
#' @param stamp Stamp unstamped tables with [sc_hard()].
#' @return The Markdown text (invisibly when `to` is given).
#' @examples
#' md <- sc_report(sc_hard(data.frame(x = 1:3), title = "three rows"), "## Note\n\ntext", title = "Pack", summary = "ok")
#' cat(substr(md, 1, 60))
#' @export
sc_report <- function(..., title = "Board pack", to = NULL, summary = NULL, author = NULL, stamp = TRUE) {
  items <- list(...)
  now <- format(Sys.time(), "%Y-%m-%d %H:%M UTC", tz = "UTC")
  parts <- c(paste0("# ", title), "", paste0("*Generated ", now, " · scelo ", .sc_version(), if (!is.null(author)) paste0(" · ", author) else "", "*"), "")
  if (!is.null(summary)) parts <- c(parts, "## Executive summary", "", summary, "")
  n <- 0L
  for (item in items) {
    if (is.character(item)) {
      parts <- c(parts, paste(item, collapse = "\n"), "")
      next
    }
    if (!is.data.frame(item) && is.list(item) && is.data.frame(item$table)) item <- item$table
    if (!is.data.frame(item)) stop("sc_report() takes tables, data frames and strings", call. = FALSE)
    n <- n + 1L
    t <- if (inherits(item, "scelo_table")) item else sc_table(item, title = sprintf("Table %d", n), stage = "hard")
    if (stamp && !length(sc_provenance(t))) t <- sc_hard(t)
    parts <- c(parts, .sc_md_block(t), "")
  }
  trail <- sc_audit()
  if (nrow(trail)) {
    parts <- c(parts, "## Audit trail", "", "| at | fn | in | out | ms |", "|---|---|---|---|---|")
    blank <- function(v) ifelse(is.na(v), "", as.character(v))
    tr <- utils::tail(trail, 40)
    parts <- c(parts, sprintf("| %s | %s | %s %s | %s %s | %s |", tr$at, tr$fn, blank(tr$in_shape), blank(tr$`in`), blank(tr$out_shape), blank(tr$out), format(tr$ms)))
    parts <- c(parts, "")
  }
  parts <- c(parts, "---", "<sub>scelo · soft data → tools → hard data. Every number above travels with its basis and its hash.</sub>")
  md <- paste(parts, collapse = "\n")
  if (!is.null(to)) {
    dir.create(dirname(to), showWarnings = FALSE, recursive = TRUE)
    tmp <- paste0(to, ".partial")
    if (tolower(tools::file_ext(to)) %in% c("html", "htm")) writeLines(.sc_md_to_html(md), tmp, useBytes = TRUE) else writeLines(md, tmp, useBytes = TRUE)
    file.rename(tmp, to)
    return(invisible(md))
  }
  md
}

.sc_html_escape <- function(s) {
  s <- gsub("&", "&amp;", s, fixed = TRUE)
  s <- gsub("<", "&lt;", s, fixed = TRUE)
  s <- gsub(">", "&gt;", s, fixed = TRUE)
  s <- gsub("\"", "&quot;", s, fixed = TRUE)
  gsub("'", "&#x27;", s, fixed = TRUE)
}

# A small Markdown → HTML for the report (headings, paragraphs, lists, pipe
# tables, code fences); no dependency. Also what sc_save() uses for .html.
.sc_md_to_html <- function(md) {
  lines <- strsplit(paste(md, collapse = "\n"), "\n", fixed = TRUE)[[1]]
  out <- c("<!doctype html><meta charset='utf-8'><title>scelo report</title>",
           paste0("<style>body{font:15px/1.5 Inter,system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#181715;background:#E8E4D8}",
                  "table{border-collapse:collapse;margin:.5rem 0;font-size:13px}td,th{border:1px solid #CDC7B8;padding:3px 8px;text-align:right}th{background:#DAD5C6}",
                  "td:first-child,th:first-child{text-align:left}pre{background:#F2EEE2;padding:.5rem;overflow:auto}sub{color:#605A51}h3{margin-top:2rem}</style>"))
  in_table <- FALSE
  in_code <- FALSE
  for (ln in lines) {
    if (startsWith(ln, "```")) {
      in_code <- !in_code
      out <- c(out, if (in_code) "<pre>" else "</pre>")
      next
    }
    if (in_code) {
      out <- c(out, .sc_html_escape(ln))
      next
    }
    if (startsWith(ln, "|")) {
      body <- sub("\\|+$", "", sub("^\\|+", "", ln))
      cells <- trimws(strsplit(body, "|", fixed = TRUE)[[1]])
      if (!length(cells)) cells <- ""
      if (all(grepl("^[-: ]*$", cells))) next
      tag <- if (in_table) "td" else "th"
      if (!in_table) {
        out <- c(out, "<table>")
        in_table <- TRUE
      }
      out <- c(out, paste0("<tr>", paste0("<", tag, ">", .sc_html_escape(cells), "</", tag, ">", collapse = ""), "</tr>"))
      next
    }
    if (in_table) {
      out <- c(out, "</table>")
      in_table <- FALSE
    }
    if (startsWith(ln, "# ")) {
      out <- c(out, paste0("<h1>", .sc_html_escape(substring(ln, 3)), "</h1>"))
    } else if (startsWith(ln, "## ")) {
      out <- c(out, paste0("<h2>", .sc_html_escape(substring(ln, 4)), "</h2>"))
    } else if (startsWith(ln, "### ")) {
      out <- c(out, paste0("<h3>", .sc_html_escape(substring(ln, 5)), "</h3>"))
    } else if (startsWith(ln, "- ")) {
      out <- c(out, paste0("<li>", .sc_html_escape(substring(ln, 3)), "</li>"))
    } else if (trimws(ln) == "---") {
      out <- c(out, "<hr>")
    } else if (nzchar(trimws(ln))) {
      txt <- .sc_html_escape(ln)
      txt <- gsub("&lt;/sub&gt;", "</sub>", gsub("&lt;sub&gt;", "<sub>", txt, fixed = TRUE), fixed = TRUE)
      out <- c(out, paste0("<p>", txt, "</p>"))
    }
  }
  if (in_table) out <- c(out, "</table>")
  paste(out, collapse = "\n")
}

# ── snapshots (the soft-data undo stack, on disk) ────────────────────────

.sc_snap_dir <- function() {
  home <- Sys.getenv("SCELO_HOME", unset = "")
  if (!nzchar(home)) home <- path.expand("~/.scelo")
  d <- file.path(home, "snapshots")
  dir.create(d, showWarnings = FALSE, recursive = TRUE)
  d
}

.sc_json_str <- function(s) paste0("\"", gsub("\"", "\\\\\"", gsub("\\", "\\\\", as.character(s), fixed = TRUE), fixed = TRUE), "\"")

# Read the flat JSON sidecar ({"key": "string" | number, ...}) without jsonlite.
.sc_read_flat_json <- function(path) {
  txt <- paste(readLines(path, warn = FALSE, encoding = "UTF-8"), collapse = " ")
  m <- gregexpr("\"([^\"\\\\]|\\\\.)*\"\\s*:\\s*(\"([^\"\\\\]|\\\\.)*\"|-?[0-9.eE+-]+|true|false|null)", txt, perl = TRUE)
  pairs <- regmatches(txt, m)[[1]]
  out <- list()
  for (p in pairs) {
    key <- sub("^\"((?:[^\"\\\\]|\\\\.)*)\"\\s*:.*$", "\\1", p, perl = TRUE)
    val <- sub("^\"(?:[^\"\\\\]|\\\\.)*\"\\s*:\\s*", "", p, perl = TRUE)
    out[[key]] <- if (startsWith(val, "\"")) gsub("\\\\(.)", "\\1", substr(val, 2, nchar(val) - 1)) else if (val %in% c("true", "false")) val == "true" else if (val == "null") NA else as.numeric(val)
  }
  out
}

#' Snapshots: a named copy of a frame on disk
#'
#' `sc_snapshot()` keeps a copy under `~/.scelo/snapshots` (or
#' `$SCELO_HOME/snapshots`) as RDS with a JSON sidecar (name, time, rows,
#' cols, hash) so a step can be undone later; `sc_restore()` loads one back
#' (RDS, or a CSV written by the Python package); `sc_snapshots()` lists them.
#' @param df A data frame.
#' @param name Snapshot name.
#' @return `sc_snapshot()` the file path (invisibly); `sc_restore()` the data
#'   frame; `sc_snapshots()` a data frame of `name`, `at`, `rows`, `cols`, `hash`.
#' @examples
#' Sys.setenv(SCELO_HOME = tempdir())
#' sc_snapshot(sc_sample("claims"), "claims0")
#' nrow(sc_restore("claims0"))
#' sc_snapshots()$name
#' @export
sc_snapshot <- function(df, name) {
  d <- .sc_snap_dir()
  df <- as.data.frame(df)
  p <- file.path(d, paste0(name, ".rds"))
  saveRDS(df, p)
  meta <- paste0("{\n  \"name\": ", .sc_json_str(name), ",\n  \"at\": ", .sc_json_str(.sc_now_iso()), ",\n  \"rows\": ", nrow(df), ",\n  \"cols\": ", ncol(df),
                 ",\n  \"hash\": ", .sc_json_str(sc_content_hash(df)), "\n}")
  writeLines(meta, file.path(d, paste0(name, ".json")), useBytes = TRUE)
  invisible(p)
}

#' @rdname sc_snapshot
#' @export
sc_restore <- function(name) {
  d <- .sc_snap_dir()
  p <- file.path(d, paste0(name, ".rds"))
  if (file.exists(p)) return(readRDS(p))
  p <- file.path(d, paste0(name, ".csv"))
  if (file.exists(p)) return(sc_load(p))
  stop(sprintf("no snapshot named '%s' in %s", name, d), call. = FALSE)
}

#' @rdname sc_snapshot
#' @export
sc_snapshots <- function() {
  files <- sort(list.files(.sc_snap_dir(), pattern = "\\.json$", full.names = TRUE))
  empty <- data.frame(name = character(), at = character(), rows = numeric(), cols = numeric(), hash = character(), stringsAsFactors = FALSE)
  if (!length(files)) return(empty)
  rows <- lapply(files, function(f) {
    m <- tryCatch(.sc_read_flat_json(f), error = function(e) list())
    pick <- function(k, alt = NULL) { v <- m[[k]]; if (is.null(v) && !is.null(alt)) v <- m[[alt]]; if (is.null(v)) NA else v }
    data.frame(name = as.character(pick("name")), at = as.character(pick("at")), rows = as.numeric(pick("rows")), cols = as.numeric(pick("cols")),
               hash = as.character(pick("hash", "sha256")), stringsAsFactors = FALSE)
  })
  do.call(rbind, rows)
}
