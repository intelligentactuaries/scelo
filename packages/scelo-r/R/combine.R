# Combine: joining and appending datasets with the IDE's rules.
#
# sc_combine(a, b) decides for you: when the schemas overlap it appends
# (with exact-duplicate removal), when a shared high-cardinality key with
# value overlap exists it left-joins on it. sc_suggest_combine() shows the
# evidence behind that decision; sc_join() / sc_append() are the explicit
# forms; sc_diff() and sc_tieout() compare two frames cell by cell.
#
# Join semantics follow apps/web/src/components/Scelo/combineData.ts (and
# packages/scelo-py/src/scelo/combine.py): the key is matched
# case-insensitively, the first right-hand match wins (a join never
# multiplies rows), clashing column names get _2, _3 ...

.SC_ID_LIKE_RE <- "(^|_)(id|key|number|no|policy|claim|member|customer|client)s?($|_)"
.SC_SAMPLE_LIMIT <- 5000L

.sc_norm_name <- function(c) tolower(trimws(as.character(c)))

# other column → base column with the same normalised name (named character vector).
.sc_aliases <- function(base, other) {
  base_norm <- .sc_norm_name(names(base))
  base_map <- stats::setNames(names(base), base_norm)
  base_map <- base_map[!duplicated(base_norm, fromLast = TRUE)]
  on <- .sc_norm_name(names(other))
  hit <- on %in% names(base_map)
  stats::setNames(unname(base_map[on[hit]]), names(other)[hit])
}

# Cell as text for key matching: numbers print as R prints them, NA / "" count as no key.
.sc_key_text <- function(x) {
  s <- if (is.factor(x)) as.character(x) else if (inherits(x, "Date")) format(x) else as.character(x)
  s[is.na(x) | is.na(s) | s == ""] <- NA_character_
  s
}

.sc_uniqueness <- function(s) {
  k <- .sc_key_text(utils::head(s, .SC_SAMPLE_LIMIT))
  k <- k[!is.na(k)]
  if (length(k)) length(unique(k)) / length(k) else 0
}

.sc_overlap <- function(a, b) {
  ka <- .sc_key_text(utils::head(a, .SC_SAMPLE_LIMIT))
  ka <- ka[!is.na(ka)]
  kb <- as.character(utils::head(b, .SC_SAMPLE_LIMIT))
  kb <- kb[!is.na(kb)]
  if (length(ka)) mean(ka %in% kb) else 0
}

# Candidate join keys, best first: list(key, right_key, uniqueness, overlap, score).
.sc_keys <- function(base, other) {
  al <- .sc_aliases(base, other)
  out <- list()
  for (oc in names(al)) {
    bc <- al[[oc]]
    u <- max(.sc_uniqueness(base[[bc]]), .sc_uniqueness(other[[oc]]))
    if (u < 0.9) next
    ov <- .sc_overlap(base[[bc]], other[[oc]])
    if (ov < 0.3) next
    score <- ov * u + (if (grepl(.SC_ID_LIKE_RE, bc, ignore.case = TRUE, perl = TRUE)) 0.15 else 0)
    out[[length(out) + 1L]] <- list(key = bc, right_key = oc, uniqueness = u, overlap = ov, score = score)
  }
  if (length(out)) out <- out[order(-vapply(out, function(k) k$score, numeric(1)))]
  out
}

#' The IDE's combine suggestion
#'
#' Strategy (`append` / `join-left`), key, schema overlap and confidence
#' for combining two frames, with the candidate keys in `attr(, "keys")`.
#' @param base,other Two data frames.
#' @return A one-row `scelo_table`: `strategy`, `key`, `right_key`,
#'   `confidence`, `dedupe_exact`, `schema_overlap`, `shared_columns`,
#'   `candidate_keys`.
#' @examples
#' a <- data.frame(policy_id = c("P1", "P2", "P3"), premium = 1:3)
#' b <- data.frame(Policy_ID = c("P1", "P2", "P2", "P4"), claims = 0:3, premium = 9)
#' sc_suggest_combine(a, b)
#' @export
sc_suggest_combine <- function(base, other) {
  .sc_tool("sc_suggest_combine", list(base = base, other = other), base, {
    al <- .sc_aliases(base, other)
    union <- ncol(base) + ncol(other) - length(al)
    schema_overlap <- if (union) length(al) / union else 0
    keys <- .sc_keys(base, other)
    best <- if (length(keys)) keys[[1]] else NULL
    if (schema_overlap >= 0.8 && !is.null(best) && best$overlap >= 0.7 && ncol(other) > length(al)) {
      strategy <- "join-left"; key <- best$key; conf <- 0.75; dedupe <- FALSE
    } else if (schema_overlap >= 0.8) {
      strategy <- "append"; key <- NULL; dedupe <- TRUE
      conf <- if (!is.null(best) && best$overlap >= 0.7) 0.6 else 0.9
    } else if (!is.null(best) && best$overlap >= 0.5) {
      strategy <- "join-left"; key <- best$key; conf <- min(0.95, best$score); dedupe <- FALSE
    } else {
      strategy <- "append"; key <- NULL; dedupe <- FALSE
      conf <- if (schema_overlap >= 0.5) 0.5 else 0.25
    }
    rows <- data.frame(
      strategy = strategy, key = if (is.null(key)) NA_character_ else key,
      right_key = if (!is.null(best) && !is.null(key)) best$right_key else NA_character_,
      confidence = conf, dedupe_exact = dedupe, schema_overlap = schema_overlap, shared_columns = length(al),
      candidate_keys = paste(vapply(keys, function(k) k$key, character(1)), collapse = ", "),
      stringsAsFactors = FALSE
    )
    t <- sc_table(rows, title = "Combine suggestion", stage = "soft", notes = c(
      "Append when ≥ 80 % of the columns line up (with exact-duplicate removal); join-left when a ≥ 90 %-unique shared column has ≥ 50 % value overlap. Confidence ≥ 0.7 high, ≥ 0.4 medium."
    ))
    attr(t, "keys") <- keys
    t
  })
}

#' Join a second frame onto a base frame
#'
#' Joins `other` onto `base` on `key` (inferred when omitted): the key is
#' matched as text, the first right match wins (a join never multiplies
#' rows), clashing column names are renamed `_2`, `_3` ...
#' @param base,other Two data frames.
#' @param key Key column in `base` (inferred from the shared columns when `NULL`).
#' @param right_key Key column in `other` (the column with the same name, case-insensitively, when `NULL`).
#' @param how `"left"` (default) keeps every base row; anything else is an inner join.
#' @return A `scelo_table`.
#' @examples
#' a <- data.frame(policy_id = c("P1", "P2", "P3"), premium = 1:3)
#' b <- data.frame(Policy_ID = c("P1", "P2", "P2", "P4"), claims = 0:3, premium = 9)
#' sc_join(a, b)
#' @export
sc_join <- function(base, other, key = NULL, right_key = NULL, how = "left") {
  .sc_tool("sc_join", list(base = base, other = other, key = key, right_key = right_key, how = how), base, {
    if (is.null(key)) {
      ks <- .sc_keys(base, other)
      if (!length(ks)) stop("no shared key column: pass key=<column>", call. = FALSE)
      key <- ks[[1]]$key; right_key <- ks[[1]]$right_key
    }
    if (!key %in% names(base)) stop(sprintf("key %s not in base dataset", key), call. = FALSE)
    rk <- right_key
    if (is.null(rk)) {
      same <- names(other)[.sc_norm_name(names(other)) == .sc_norm_name(key)]
      rk <- if (length(same)) same[1] else key
    }
    if (!rk %in% names(other)) stop(sprintf("key %s not in second dataset", rk), call. = FALSE)
    base_set <- .sc_norm_name(names(base))
    rename <- character()
    for (c in setdiff(names(other), rk)) {
      name <- c
      if (.sc_norm_name(name) %in% base_set) {
        n <- 2L
        while (.sc_norm_name(sprintf("%s_%d", c, n)) %in% base_set) n <- n + 1L
        name <- sprintf("%s_%d", c, n)
      }
      base_set <- c(base_set, .sc_norm_name(name))
      rename[c] <- name
    }
    right <- other[setdiff(names(other), rk)]
    names(right) <- unname(rename[names(right)])
    rk_vals <- .sc_key_text(other[[rk]])
    valid <- !is.na(rk_vals)
    dup_right <- sum(duplicated(rk_vals[valid]))
    first <- valid & !duplicated(rk_vals)
    right <- right[first, , drop = FALSE]
    idx <- match(.sc_key_text(base[[key]]), rk_vals[first])
    matched <- sum(!is.na(idx))
    keep <- if (how == "left") seq_len(nrow(base)) else which(!is.na(idx))
    left <- if (inherits(base, "scelo_table")) sc_df(base) else as.data.frame(base, stringsAsFactors = FALSE)
    merged <- left[keep, , drop = FALSE]
    picked <- right[idx[keep], , drop = FALSE]
    for (c in names(picked)) merged[[c]] <- picked[[c]]
    rownames(merged) <- NULL
    renamed <- rename[rename != names(rename)]
    sc_table(merged, title = sprintf("%s join on %s", how, key), stage = "soft", notes = paste0(
      sprintf("%s of %s base rows matched; %s unmatched%s; %d duplicate right keys ignored (first wins).",
              .sc_fmt_n(matched), .sc_fmt_n(nrow(base)), .sc_fmt_n(nrow(base) - matched), if (how == "left") " kept with nulls" else " dropped", dup_right),
      if (length(renamed)) sprintf(" Renamed: %s.", paste(sprintf("%s→%s", names(renamed), renamed), collapse = ", ")) else ""
    ))
  })
}

# Stack two frames on the union of their columns (a's order first); a column
# missing on one side is filled with NA of the other side's type.
.sc_rbind_union <- function(a, b, cols) {
  out <- lapply(cols, function(c) {
    va <- if (c %in% names(a)) a[[c]] else NULL
    vb <- if (c %in% names(b)) b[[c]] else NULL
    if (is.factor(va)) va <- as.character(va)
    if (is.factor(vb)) vb <- as.character(vb)
    if (is.null(va)) va <- rep(vb[NA_integer_], nrow(a))
    if (is.null(vb)) vb <- rep(va[NA_integer_], nrow(b))
    da <- inherits(va, c("Date", "POSIXt")); db <- inherits(vb, c("Date", "POSIXt"))
    if (da != db || (da && db && !identical(class(va), class(vb)))) {
      va <- if (da) format(va) else as.character(va)
      vb <- if (db) format(vb) else as.character(vb)
    }
    c(va, vb)
  })
  names(out) <- cols
  out <- as.data.frame(out, stringsAsFactors = FALSE, check.names = FALSE, optional = TRUE)
  names(out) <- cols
  out
}

#' Append one frame below another
#'
#' Columns are matched case-insensitively and the union is kept (base order
#' first); exact duplicates are dropped when `dedupe`. `sc_stack()` is an
#' alias.
#' @param base,other Two data frames.
#' @param dedupe Drop exact duplicate rows after appending.
#' @return A `scelo_table`.
#' @examples
#' a <- data.frame(policy_id = c("P1", "P2", "P3"), premium = 1:3)
#' sc_append(a, data.frame(policy_id = c("P1", "P2", "P3"), premium = c(1, 2, 5)))
#' @export
sc_append <- function(base, other, dedupe = TRUE) {
  .sc_tool("sc_append", list(base = base, other = other, dedupe = dedupe), base, {
    al <- .sc_aliases(base, other)
    mapped <- if (inherits(other, "scelo_table")) sc_df(other) else as.data.frame(other, stringsAsFactors = FALSE)
    nm <- names(mapped)
    nm[match(names(al), nm)] <- unname(al)
    names(mapped) <- nm
    new_cols <- setdiff(nm, names(base))
    left <- if (inherits(base, "scelo_table")) sc_df(base) else as.data.frame(base, stringsAsFactors = FALSE)
    out <- .sc_rbind_union(left, mapped, c(names(base), new_cols))
    n_before <- nrow(out)
    if (dedupe) {
      out <- out[!.sc_duplicated_rows(out), , drop = FALSE]
      rownames(out) <- NULL
    }
    sc_table(out, title = "append", stage = "soft", notes = if (dedupe) {
      sprintf("%s rows appended; %d new column(s); %s exact duplicates dropped.", .sc_fmt_n(nrow(other)), length(new_cols), .sc_fmt_n(n_before - nrow(out)))
    } else {
      sprintf("%s rows appended; %d new column(s).", .sc_fmt_n(nrow(other)), length(new_cols))
    })
  })
}

#' @rdname sc_append
#' @export
sc_stack <- sc_append

#' Combine datasets the way the IDE does
#'
#' Each step is suggested (append or join-left, see [sc_suggest_combine()])
#' unless `how` / `key` force it.
#' @param base The first data frame.
#' @param ... Further data frames, combined one at a time.
#' @param key Join key to force.
#' @param how `"append"`, `"join"` / `"join-left"` / `"left"`, `"inner"` /
#'   `"join-inner"`, or `NULL` to let each step be suggested.
#' @return A `scelo_table` whose notes record each step.
#' @examples
#' a <- data.frame(policy_id = c("P1", "P2", "P3"), premium = 1:3)
#' sc_combine(a, data.frame(policy_id = c("P1", "P2", "P3"), premium = c(1, 2, 5)))
#' @export
sc_combine <- function(base, ..., key = NULL, how = NULL) {
  others <- list(...)
  .sc_tool("sc_combine", list(base = base, n = length(others), key = key, how = how), base, {
    out <- base
    notes <- character()
    for (other in others) {
      if (identical(how, "append")) {
        step <- sc_append(out, other)
      } else if (!is.null(how) && how %in% c("join", "join-left", "left")) {
        step <- sc_join(out, other, key)
      } else if (!is.null(how) && how %in% c("inner", "join-inner")) {
        step <- sc_join(out, other, key, how = "inner")
      } else {
        s <- sc_suggest_combine(out, other)
        step <- if (s$strategy == "join-left") sc_join(out, other, s$key, s$right_key) else sc_append(out, other, dedupe = isTRUE(s$dedupe_exact))
        notes <- c(notes, sprintf("%s (confidence %.2f)", s$strategy, s$confidence))
      }
      notes <- c(notes, sc_notes(step))
      out <- step
    }
    plain <- if (inherits(out, "scelo_table")) sc_df(out) else as.data.frame(out, stringsAsFactors = FALSE)
    sc_table(plain, title = sprintf("combine · %d datasets", length(others) + 1L), stage = "soft", notes = notes)
  })
}

#' Cells that differ between two frames
#'
#' Rows are aligned on `key` (or by position) and the shared columns
#' compared: numeric columns within `tol`, everything else as text; `NA`
#' against `NA` is not a difference.
#' @param a,b Two data frames.
#' @param key Column to align on (`NULL`: by position, the key is then the row number).
#' @param tol Absolute tolerance for numeric columns.
#' @return A `scelo_table` with `key`, `column`, `a`, `b`, `delta`.
#' @examples
#' a <- data.frame(policy_id = c("P1", "P2", "P3"), premium = 1:3)
#' sc_diff(a, data.frame(policy_id = c("P1", "P2", "P3"), premium = c(1, 2, 5)), key = "policy_id")
#' @export
sc_diff <- function(a, b, key = NULL, tol = 0) {
  if (!is.null(key)) {
    ka <- as.character(a[[key]]); kb <- as.character(b[[key]])
    common <- ka[ka %in% kb]
    ia <- match(common, ka); ib <- match(common, kb)
    only_a_rows <- sum(!ka %in% kb); only_b_rows <- sum(!kb %in% ka)
    cols <- setdiff(intersect(names(a), names(b)), key)
  } else {
    n <- min(nrow(a), nrow(b))
    common <- seq_len(n)
    ia <- ib <- seq_len(n)
    only_a_rows <- nrow(a) - n; only_b_rows <- nrow(b) - n
    cols <- intersect(names(a), names(b))
  }
  chunks <- list()
  for (c in cols) {
    va <- a[[c]][ia]; vb <- b[[c]][ib]
    num <- is.numeric(va) && is.numeric(vb)
    if (num) {
      d <- abs(as.numeric(va) - as.numeric(vb))
      m <- (!is.na(d) & d > tol) | (is.na(va) != is.na(vb))
    } else {
      sa <- as.character(va); sb <- as.character(vb)
      m <- !(is.na(sa) & is.na(sb)) & (is.na(sa) != is.na(sb) | (!is.na(sa) & !is.na(sb) & sa != sb))
    }
    if (any(m)) chunks[[length(chunks) + 1L]] <- list(key = common[m], column = rep(c, sum(m)), a = va[m], b = vb[m], delta = if (num) as.numeric(va[m]) - as.numeric(vb[m]) else rep(NA_real_, sum(m)))
  }
  all_num <- length(chunks) > 0 && all(vapply(chunks, function(ch) is.numeric(ch$a) && is.numeric(ch$b), logical(1)))
  cell <- function(v) if (all_num) as.numeric(v) else as.character(v)
  out <- if (length(chunks)) {
    data.frame(
      key = if (is.null(key)) as.integer(unlist(lapply(chunks, `[[`, "key"))) else as.character(unlist(lapply(chunks, `[[`, "key"))),
      column = unlist(lapply(chunks, `[[`, "column")),
      a = unlist(lapply(chunks, function(ch) cell(ch$a))), b = unlist(lapply(chunks, function(ch) cell(ch$b))),
      delta = unlist(lapply(chunks, `[[`, "delta")), stringsAsFactors = FALSE
    )
  } else {
    data.frame(key = character(), column = character(), a = character(), b = character(), delta = numeric(), stringsAsFactors = FALSE)
  }
  only_a <- setdiff(names(a), names(b)); only_b <- setdiff(names(b), names(a))
  sc_table(out, title = sprintf("diff · %d differing cells", nrow(out)), stage = "hard", notes = sprintf(
    "%s aligned rows; rows only in a: %d, only in b: %d; columns only in a: %s, only in b: %s.",
    .sc_fmt_n(length(common)), only_a_rows, only_b_rows,
    if (length(only_a)) paste(only_a, collapse = ", ") else "none", if (length(only_b)) paste(only_b, collapse = ", ") else "none"
  ))
}

#' Do two results tie out?
#'
#' `TRUE` when two numbers, vectors or frames agree within `tol` (absolute,
#' or relative with `rel = TRUE`); non-numeric cells must match as text.
#' @param a,b Numbers, vectors or data frames.
#' @param tol Tolerance.
#' @param rel Relative tolerance (`tol` times the larger magnitude).
#' @return A logical scalar.
#' @examples
#' sc_tieout(1, 1 + 1e-9)
#' sc_tieout(data.frame(x = 1:3), data.frame(x = c(1, 2, 5)))
#' @export
sc_tieout <- function(a, b, tol = 1e-6, rel = FALSE) {
  if (is.atomic(a) && is.atomic(b) && length(a) == 1 && length(b) == 1 && is.numeric(a) && is.numeric(b)) {
    d <- abs(as.numeric(a) - as.numeric(b))
    return(d <= (if (rel) tol * max(abs(as.numeric(a)), abs(as.numeric(b)), 1e-300) else tol))
  }
  A <- if (is.data.frame(a)) as.data.frame(a) else data.frame(x = a, stringsAsFactors = FALSE)
  B <- if (is.data.frame(b)) as.data.frame(b) else data.frame(x = b, stringsAsFactors = FALSE)
  if (nrow(A) != nrow(B) || ncol(A) != ncol(B)) return(FALSE)
  tonum <- function(df) vapply(df, function(col) suppressWarnings(as.numeric(if (is.factor(col)) as.character(col) else col)), numeric(nrow(df)))
  An <- matrix(tonum(A), nrow(A)); Bn <- matrix(tonum(B), nrow(B))
  num <- !is.na(An) & !is.na(Bn)
  ok <- if (rel) abs(An[num] - Bn[num]) <= tol * pmax(abs(An[num]), abs(Bn[num])) else abs(An[num] - Bn[num]) <= tol
  if (!all(ok)) return(FALSE)
  rest <- !num
  if (!any(rest)) return(TRUE)
  As <- matrix(vapply(A, as.character, character(nrow(A))), nrow(A)); Bs <- matrix(vapply(B, as.character, character(nrow(B))), nrow(B))
  x <- As[rest]; y <- Bs[rest]
  all((is.na(x) & is.na(y)) | (!is.na(x) & !is.na(y) & x == y))
}
