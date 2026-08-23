# A scelo_table is a data.frame that carries its own caveats.
#
# Every table-shaped Scelo result is one: a plain data.frame (subset it,
# merge it, plot it) with four extra attributes that survive the common
# operations: title, basis (one line of provenance), notes (what an actuary
# should know before trusting it) and provenance (the stamp sc_hard() adds:
# content hash, time, scelo version, audit trail). Printing shows the frame
# and then the notes, so the caveat is on screen at the moment the number is.

#' Make a scelo table
#'
#' Wrap a data frame as a `scelo_table`, the type every Scelo result uses: a
#' data.frame carrying `title`, `basis`, `notes`, `provenance` and `stage`.
#'
#' @param df A data frame.
#' @param title One line naming the table.
#' @param basis One line of provenance ("Gompertz-Makeham (illustrative) · i = 4 %").
#' @param notes Character vector of caveats.
#' @param stage "soft" or "hard".
#' @param provenance A list written by [sc_hard()].
#' @return A `scelo_table`.
#' @examples
#' t <- sc_table(data.frame(x = 1:3), title = "three rows", notes = "toy")
#' print(t)
#' @export
sc_table <- function(df, title = NULL, basis = NULL, notes = character(), stage = "soft", provenance = NULL) {
  df <- as.data.frame(df, stringsAsFactors = FALSE)
  if (inherits(df, "scelo_table")) {
    if (is.null(title)) title <- attr(df, "title")
    if (is.null(basis)) basis <- attr(df, "basis")
    if (!length(notes)) notes <- attr(df, "notes")
    if (is.null(provenance)) provenance <- attr(df, "provenance")
  }
  attr(df, "title") <- title
  attr(df, "basis") <- basis
  attr(df, "notes") <- as.character(notes %||% character())
  attr(df, "provenance") <- provenance
  attr(df, "stage") <- stage
  class(df) <- unique(c("scelo_table", class(df)))
  df
}

`%||%` <- function(a, b) if (is.null(a)) b else a

#' Notes, title and basis of a Scelo result
#'
#' @param x Any object; a `scelo_table` carries notes.
#' @return `sc_notes()` a character vector (empty for plain objects);
#'   `sc_title()` / `sc_basis()` a string or `NULL`.
#' @examples
#' sc_notes(sc_life_table())
#' @export
sc_notes <- function(x) as.character(attr(x, "notes") %||% character())

#' @rdname sc_notes
#' @export
sc_title <- function(x) attr(x, "title")

#' @rdname sc_notes
#' @export
sc_basis <- function(x) attr(x, "basis")

#' Append a note to a table
#'
#' @param x A `scelo_table`.
#' @param text The note.
#' @return The table, with the note appended.
#' @export
sc_note <- function(x, text) {
  attr(x, "notes") <- c(sc_notes(x), text)
  x
}

#' Plain data frame
#'
#' Drop the Scelo attributes and return an ordinary data.frame.
#' @param x A `scelo_table`.
#' @return A data.frame.
#' @export
sc_df <- function(x) {
  for (a in c("title", "basis", "notes", "provenance", "stage")) attr(x, a) <- NULL
  class(x) <- "data.frame"
  x
}

.sc_footer <- function(x) {
  out <- character()
  if (!is.null(attr(x, "title"))) out <- c(out, paste0("— ", attr(x, "title")))
  if (!is.null(attr(x, "basis"))) out <- c(out, paste0("  basis: ", attr(x, "basis")))
  for (n in sc_notes(x)) out <- c(out, paste0("  · ", n))
  p <- attr(x, "provenance")
  if (!is.null(p) && !is.null(p$hash)) out <- c(out, sprintf("  hard · %s · scelo %s · %s", substr(p$hash, 1, 12), p$scelo, p$at))
  out
}

#' @export
print.scelo_table <- function(x, ..., n = getOption("scelo.print_rows", 60L)) {
  df <- sc_df(x)
  if (nrow(df) > n) {
    print(utils::head(df, n), ...)
    cat(sprintf("  ... %d more rows (options(scelo.print_rows = N) to show more)\n", nrow(df) - n))
  } else {
    print(df, ...)
  }
  foot <- .sc_footer(x)
  if (length(foot)) cat(foot, sep = "\n")
  invisible(x)
}

#' @export
`[.scelo_table` <- function(x, i, j, ..., drop = FALSE) {
  keep <- c("title", "basis", "notes", "provenance", "stage")
  attrs <- lapply(keep, function(a) attr(x, a))
  out <- NextMethod()
  if (is.data.frame(out)) {
    for (k in seq_along(keep)) attr(out, keep[k]) <- attrs[[k]]
    class(out) <- unique(c("scelo_table", class(out)))
  }
  out
}

#' @export
as.data.frame.scelo_table <- function(x, ...) sc_df(x)

#' Format a table as a Markdown report block
#'
#' Title, basis, a pipe table and the notes, the block [sc_report()] writes
#' for each table.
#' @param x A data frame or `scelo_table`.
#' @param digits Significant digits for numbers.
#' @return A single string.
#' @export
sc_markdown <- function(x, digits = 6) {
  df <- if (inherits(x, "scelo_table")) sc_df(x) else as.data.frame(x)
  out <- character()
  if (!is.null(attr(x, "title"))) out <- c(out, paste0("### ", attr(x, "title")))
  if (!is.null(attr(x, "basis"))) out <- c(out, paste0("*Basis:* ", attr(x, "basis")))
  out <- c(out, "", .sc_pipe_table(df, digits))
  if (length(sc_notes(x))) out <- c(out, "", paste0("- ", sc_notes(x)))
  p <- attr(x, "provenance")
  if (!is.null(p) && !is.null(p$hash)) out <- c(out, "", sprintf("<sub>hard · %s · scelo %s · %s</sub>", substr(p$hash, 1, 16), p$scelo, p$at))
  paste(out, collapse = "\n")
}

.sc_fmt_cell <- function(v, digits) {
  if (is.numeric(v)) ifelse(is.na(v), "", formatC(v, digits = digits, format = "g", big.mark = ",")) else ifelse(is.na(v), "", as.character(v))
}

.sc_pipe_table <- function(df, digits = 6) {
  if (!nrow(df)) return("(empty)")
  cells <- vapply(names(df), function(c) .sc_fmt_cell(df[[c]], digits), character(nrow(df)))
  if (is.null(dim(cells))) cells <- matrix(cells, nrow = 1)
  header <- paste0("| ", paste(names(df), collapse = " | "), " |")
  sep <- paste0("|", paste(rep("---", ncol(df)), collapse = "|"), "|")
  body <- apply(cells, 1, function(r) paste0("| ", paste(r, collapse = " | "), " |"))
  c(header, sep, body)
}
