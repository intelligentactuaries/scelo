# Cleaning: the IDE's cleaning banner as functions.
#
# sc_suggest(df) reads the data and proposes operations with the evidence
# for each (cells affected, columns, why). sc_clean(df) applies the *safe*
# ones: the nine that cannot lose information (trim, collapse whitespace,
# fix mojibake, null the missing markers, parse numbers / dates / booleans,
# null numeric sentinels, coerce numeric residue). sc_clean(df, "all") also
# runs the learned and destructive ones (impute, cap outliers, drop
# duplicates / empty / constant columns, lower-case categoricals, recode
# near-duplicate labels, null future years, snake-case headers) and iterates
# until the data is clean, stalls, or eight passes are spent, the way the
# IDE's autonomous clean does.
#
# Every threshold here is the IDE's (apps/web/src/components/Scelo/cleaning.ts,
# mirrored by packages/scelo-py/src/scelo/clean.py), so the library and the
# banner propose the same ops on the same file. One R-specific point: R has
# no object column of mixed numbers and strings, so a strictly numeric string
# ("3218.19") counts as a number the way Scelo types it at import, and the
# "string cells" every rule looks at are the non-numeric ones. A character
# column that gets parsed becomes numeric / Date / logical.

# ── constants (verbatim from cleaning.ts) ───────────────────────────────────

#' Token sets and op lists behind the cleaning rules
#'
#' `SC_MISSING_TOKENS`: cell values (lower-cased, trimmed) that mean
#' "missing"; `SC_TRUE_TOKENS` / `SC_FALSE_TOKENS`: boolean spellings;
#' `SC_NUMERIC_SENTINELS`: legacy numeric placeholders; `SC_SAFE_OPS`: the
#' nine ops [sc_clean()] runs by default; `SC_ALL_OPS`: every op, in the
#' IDE's order.
#' @format Character / numeric vectors.
#' @export
SC_MISSING_TOKENS <- c(
  "na", "n/a", "n.a.", "n/a.", "nan", "null", "nil", "none", "missing", "unknown", "undefined", "void",
  "no data", "no value", "not available", "not applicable",
  "<na>", "#na", "#n/a",
  "#null!", "#div/0!", "#value!", "#ref!", "#name?", "#num!",
  "-", "--", "---", "\u2014", "\u2013", "?", "??", "*", "**", ".", "x",
  "tbd", "tbc", "pending", "blank", "empty"
)

#' @rdname SC_MISSING_TOKENS
#' @export
SC_TRUE_TOKENS <- c("true", "yes", "y", "t", "on", "ok", "\u2713", "\u2714")

#' @rdname SC_MISSING_TOKENS
#' @export
SC_FALSE_TOKENS <- c("false", "no", "n", "f", "off", "\u2717", "\u2718", "x")

#' @rdname SC_MISSING_TOKENS
#' @export
SC_NUMERIC_SENTINELS <- c(
  -1, -9, -99, -999, -9999, -99999, -999999, -888, -8888, 9, 99, 999, 9999, 99999, 999999,
  -999.99, 9999.99, 999.99
)

# (bad, good) pairs in the IDE's order: the order matters ("â€" is
# replaced before "â€¦"), so it is kept verbatim; written as \u escapes.
.SC_MOJIBAKE_PAIRS <- list(
  c("\u00E2\u20AC\u2122", "\u2019"), c("\u00E2\u20AC\u02DC", "\u2018"), c("\u00E2\u20AC\u0153", "\u201C"), c("\u00E2\u20AC", "\u201D"), c("\u00E2\u20AC\u00A6", "\u2026"), c("\u00E2\u20AC\u00A2", "\u2022"),
  c("\u00C3\u00A9", "\u00E9"), c("\u00C3\u00A8", "\u00E8"), c("\u00C3\u00AA", "\u00EA"), c("\u00C3\u00AB", "\u00EB"), c("\u00C3 ", "\u00E0"), c("\u00C3\u00A2", "\u00E2"), c("\u00C3\u00AE", "\u00EE"), c("\u00C3\u00AF", "\u00EF"),
  c("\u00C3\u00B4", "\u00F4"), c("\u00C3\u00B6", "\u00F6"), c("\u00C3\u00BB", "\u00FB"), c("\u00C3\u00BC", "\u00FC"), c("\u00C3\u00A7", "\u00E7"), c("\u00C3\u00B1", "\u00F1"), c("\u00C3\u00A1", "\u00E1"), c("\u00C3\u00AD", "\u00ED"),
  c("\u00C3\u00B3", "\u00F3"), c("\u00C3\u00BA", "\u00FA"), c("\u00C3\u201E", "\u00C4"), c("\u00C3\u2013", "\u00D6"), c("\u00C3\u0153", "\u00DC"), c("\u00C3\u0178", "\u00DF"),
  c("\u00C2\u00A3", "\u00A3"), c("\u00C2\u00A9", "\u00A9"), c("\u00C2\u00AE", "\u00AE"), c("\u00C2\u00B0", "\u00B0"), c("\u00C2 ", " ")
)
.SC_ENCODING_NOISE_RE <- "[\uFEFF\u00A0\u200B\u200C\u200D\u2060\u00AD]"
.SC_ZERO_WIDTH_RE <- "[\uFEFF\u200B\u200C\u200D\u2060\u00AD]"
.SC_INTERNAL_WS_RE <- "(*UCP)\\s{2,}"
.SC_ISO_TIMESTAMP_RE <- "^(\\d{4})-(\\d{1,2})-(\\d{1,2})[T ](\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:\\.(\\d+))?(Z|[+-]\\d{2}:?\\d{2})?$"
.SC_MONTHS <- c(
  jan = 1L, feb = 2L, mar = 3L, apr = 4L, may = 5L, jun = 6L, jul = 7L, aug = 8L, sep = 9L, oct = 10L, nov = 11L, dec = 12L,
  january = 1L, february = 2L, march = 3L, april = 4L, june = 6L, july = 7L, august = 8L, september = 9L, october = 10L, november = 11L, december = 12L,
  sept = 9L
)
.SC_YEAR_COL_RE <- "year|yr"
.SC_ID_NAME_RE <- "(*UCP)(^|[_\\s])(id|no|num|number|ref|code)$"
.SC_CURRENCY_RE <- "[$\u00A3\u20AC\u00A5\u20B9]"
.SC_CCY_CODE_RE <- "(*UCP)\\s*[A-Za-z]{3,4}\\s*$"
.SC_CCY_PREFIX_RE <- "(*UCP)^[A-Za-z]{1,3}\\s+(?=[\\d(+\\-.])"
.SC_SEP_RE <- "(*UCP)[,_\\s\u00A0]"
.SC_DASH_RE <- "[\u2010-\u2015\u2212]"
.SC_NUM_PREFIX_RE <- "^[+-]?[0-9]+(?:\\.[0-9]+)?"
.SC_STRICT_FLOAT_RE <- "^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?$"
.SC_SNAKE_QUOTES <- "['\"`]"
.SC_SNAKE_CAMEL <- "([a-z0-9])([A-Z])"
.SC_SNAKE_SEP <- "(*UCP)[\\s\\-.\\\\/()\\[\\]{}]+"
.SC_SNAKE_MULTI <- "__+"
.SC_SNAKE_EDGE <- "^_+|_+$"

# Every date shape below starts with 1-4 digits and a separator, 1-2 digits and a space, or a 3-9 letter month: the screen before the patterns.
.SC_DATE_START_RE <- "(*UCP)^[0-9]{1,4}[-/.]|^[0-9]{1,2}\\s|^[A-Za-z]{3,9}\\s"
.SC_P_ISO <- "^(\\d{4})-(\\d{1,2})-(\\d{1,2})(?:[T ]\\d.*)?$"
.SC_P_YSL <- "^(\\d{4})/(\\d{1,2})/(\\d{1,2})$"
.SC_P_NUM <- "^(\\d{1,2})[/\\-.](\\d{1,2})[/\\-.](\\d{2,4})$"
.SC_P_MON1 <- "^([A-Za-z]{3,9})\\s+(\\d{1,2}),?\\s+(\\d{2,4})$"
.SC_P_MON2 <- "^(\\d{1,2})\\s+([A-Za-z]{3,9}),?\\s+(\\d{2,4})$"

.SC_AUTO_CLEAN_MAX_PASSES <- 8L

#' @rdname SC_MISSING_TOKENS
#' @export
SC_SAFE_OPS <- c(
  "fix-encoding", "trim", "collapse-whitespace", "missing-tokens", "standardise-booleans", "parse-dates",
  "parse-numeric", "coerce-numeric", "replace-numeric-sentinels"
)
.SC_UNSAFE_OPS <- c(
  "recode-value", "null-future-years", "lowercase-categoricals", "drop-duplicates", "drop-empty-cols",
  "drop-constant-cols", "rename-snake-case", "cap-outliers", "impute-missing"
)

#' @rdname SC_MISSING_TOKENS
#' @export
SC_ALL_OPS <- c(SC_SAFE_OPS, .SC_UNSAFE_OPS)

.SC_OP_ALIASES <- c(
  whitespace = "trim", strip = "trim", "trim-whitespace" = "trim",
  collapse = "collapse-whitespace", "collapse-ws" = "collapse-whitespace",
  encoding = "fix-encoding", mojibake = "fix-encoding",
  missing = "missing-tokens", "missing-markers" = "missing-tokens", nulls = "missing-tokens",
  numbers = "parse-numeric", numeric = "parse-numeric", "parse-numbers" = "parse-numeric", money = "parse-numeric",
  dates = "parse-dates", date = "parse-dates",
  booleans = "standardise-booleans", bool = "standardise-booleans", bools = "standardise-booleans",
  sentinels = "replace-numeric-sentinels", sentinel = "replace-numeric-sentinels",
  coerce = "coerce-numeric",
  recode = "recode-value", typos = "recode-value",
  "future-years" = "null-future-years",
  impute = "impute-missing", fillna = "impute-missing", fill = "impute-missing", median = "impute-missing", mode = "impute-missing",
  cap = "cap-outliers", winsorize = "cap-outliers", winsorise = "cap-outliers", clip = "cap-outliers", tukey = "cap-outliers", iqr = "cap-outliers", outliers = "cap-outliers",
  dedupe = "drop-duplicates", duplicates = "drop-duplicates", dedup = "drop-duplicates",
  empty = "drop-empty-cols", "drop-empty" = "drop-empty-cols",
  constant = "drop-constant-cols", "drop-constant" = "drop-constant-cols",
  lowercase = "lowercase-categoricals", lower = "lowercase-categoricals", case = "lowercase-categoricals",
  snake = "rename-snake-case", snakecase = "rename-snake-case", "snake-case" = "rename-snake-case", headers = "rename-snake-case", rename = "rename-snake-case", names = "rename-snake-case"
)

.SC_OP_TITLES <- c(
  "fix-encoding" = "fix encoding", trim = "trim whitespace", "collapse-whitespace" = "collapse internal whitespace",
  "missing-tokens" = "null missing markers", "parse-numeric" = "parse numbers", "parse-dates" = "parse dates",
  "standardise-booleans" = "standardise booleans", "replace-numeric-sentinels" = "null numeric sentinels",
  "coerce-numeric" = "coerce numeric residue", "recode-value" = "recode near-duplicate label",
  "null-future-years" = "null future years", "drop-duplicates" = "drop duplicate rows",
  "drop-empty-cols" = "drop empty columns", "drop-constant-cols" = "drop constant columns",
  "lowercase-categoricals" = "lower-case categoricals", "rename-snake-case" = "snake_case headers",
  "cap-outliers" = "cap outliers to the Tukey fences", "impute-missing" = "impute missing values"
)

.sc_norm_op <- function(key) {
  k <- gsub("_", "-", tolower(trimws(key)), fixed = TRUE)
  if (k %in% names(.SC_OP_ALIASES)) k <- unname(.SC_OP_ALIASES[[k]])
  if (!k %in% SC_ALL_OPS) stop(sprintf("unknown cleaning op '%s': choose from %s", key, paste(SC_ALL_OPS, collapse = ", ")), call. = FALSE)
  k
}


# ── scalar / vector helpers ─────────────────────────────────────────────────

# Python's str.strip(): Unicode horizontal and vertical whitespace (NBSP
# included). One scan finds the padded strings, the PCRE trim runs on those.
.sc_strip <- function(s) {
  need <- grepl("^[\\h\\v]|[\\h\\v]$", s, perl = TRUE)
  if (any(need)) s[need] <- trimws(s[need], whitespace = "[\\h\\v]")
  s
}

.sc_fmt_n <- function(n) format(as.numeric(n), big.mark = ",", scientific = FALSE, trim = TRUE)

# Capture groups of a PCRE pattern as a character matrix: NA rows where the
# pattern does not match, "" for optional groups that took part in no match.
.sc_capture <- function(s, re) {
  r <- regexpr(re, s, perl = TRUE)
  st <- attr(r, "capture.start")
  ln <- attr(r, "capture.length")
  ng <- ncol(st)
  out <- matrix(NA_character_, length(s), ng)
  hit <- !is.na(r) & r > 0
  if (any(hit)) for (j in seq_len(ng)) out[hit, j] <- substring(s[hit], st[hit, j], st[hit, j] + ln[hit, j] - 1L)
  out
}

# One PCRE alternation of the literal mojibake fragments (\Q...\E quoting).
.SC_MOJIBAKE_ANY_RE <- paste0("\\Q", vapply(.SC_MOJIBAKE_PAIRS, `[`, character(1), 1L), "\\E", collapse = "|")

.sc_fix_encoding_str <- function(s) {
  hit <- grepl(.SC_MOJIBAKE_ANY_RE, s, perl = TRUE)
  if (any(hit)) {
    t <- s[hit]
    for (p in .SC_MOJIBAKE_PAIRS) t <- gsub(p[1], p[2], t, fixed = TRUE)
    s[hit] <- t
  }
  noise <- grepl(.SC_ENCODING_NOISE_RE, s, perl = TRUE)
  if (any(noise)) s[noise] <- gsub(.SC_ZERO_WIDTH_RE, "", gsub("\u00A0", " ", s[noise], fixed = TRUE), perl = TRUE)
  s
}

.sc_collapse_ws_str <- function(s) gsub(.SC_INTERNAL_WS_RE, " ", s, perl = TRUE)

.sc_missing_tokens_str <- function(s, toks = SC_MISSING_TOKENS) {
  s[tolower(.sc_strip(s)) %in% toks] <- NA_character_
  s
}

#' snake_case a header
#'
#' `"Customer Name"` becomes `customer_name`, `camelCaseHeader` becomes
#' `camel_case_header`; `NA` when the result is empty or unchanged.
#' @param name Character vector of names.
#' @return A character vector, `NA` where nothing changes.
#' @examples
#' sc_snake_case(c("Customer Name", "camelCaseHeader", "already_snake"))
#' @export
sc_snake_case <- function(name) {
  name <- as.character(name)
  s <- gsub(.SC_SNAKE_QUOTES, "", name, perl = TRUE)
  s <- gsub(.SC_SNAKE_CAMEL, "\\1_\\2", s, perl = TRUE)
  s <- gsub(.SC_SNAKE_SEP, "_", s, perl = TRUE)
  s <- gsub(.SC_SNAKE_MULTI, "_", s, perl = TRUE)
  s <- tolower(gsub(.SC_SNAKE_EDGE, "", s, perl = TRUE))
  s[is.na(s) | s == "" | s == name] <- NA_character_
  s
}

#' Flexible number parse
#'
#' `"R 1,234.50"`, `"(1,200)"` (accounting negative), `"85%"` (value kept
#' as displayed), `"1 200 ZAR"`, `"$-3"`, a Unicode minus: the cell as a
#' number, `NA` when it is not one.
#'
#' Order: Unicode dashes become ASCII; accounting parentheses negate; a
#' trailing % is stripped; currency symbols, a trailing 3-4-letter code and
#' a leading 1-3-letter code ("R 1,234.50") are removed; thousand separators
#' (comma, underscore, space, NBSP) are removed; then a strict float.
#' @param x A vector (numbers pass through; logicals give `NA`).
#' @return A numeric vector.
#' @examples
#' sc_parse_number(c("R 1,234.50", "(1,200)", "85%", "1 200 ZAR", "abc"))
#' @export
sc_parse_number <- function(x) {
  if (is.numeric(x)) {
    v <- as.numeric(x)
    v[is.nan(v)] <- NA_real_
    return(v)
  }
  if (is.logical(x) || inherits(x, c("Date", "POSIXt"))) return(rep(NA_real_, length(x)))
  s <- .sc_strip(as.character(x))
  out <- rep(NA_real_, length(s))
  # Exact screens: a number needs a digit, and a run of 5+ ASCII letters survives every stripping step, so such cells are NA without the pipeline.
  ok <- !is.na(s) & grepl("[0-9]", s) & !grepl("[A-Za-z]{5,}", s)
  if (!any(ok)) return(out)
  s <- gsub(.SC_DASH_RE, "-", s[ok], perl = TRUE)
  negate <- nchar(s) >= 2 & startsWith(s, "(") & endsWith(s, ")")
  s[negate] <- .sc_strip(substr(s[negate], 2L, nchar(s[negate]) - 1L))
  pct <- endsWith(s, "%")
  s[pct] <- substr(s[pct], 1L, nchar(s[pct]) - 1L)
  s <- gsub(.SC_CURRENCY_RE, "", s, perl = TRUE)
  s <- sub(.SC_CCY_CODE_RE, "", s, perl = TRUE)
  s <- sub(.SC_CCY_PREFIX_RE, "", s, perl = TRUE)
  s <- gsub(.SC_SEP_RE, "", s, perl = TRUE)
  v <- rep(NA_real_, length(s))
  good <- !(s %in% c("", "-", "+")) & grepl(.SC_STRICT_FLOAT_RE, s, perl = TRUE)
  v[good] <- as.numeric(s[good])
  v[!is.finite(v)] <- NA_real_
  neg <- negate & !is.na(v)
  v[neg] <- -v[neg]
  out[ok] <- v
  out
}

.sc_coerce_numeric_value <- function(u) {
  v <- sc_parse_number(u)
  miss <- which(is.na(v))
  if (length(miss)) {
    s <- .sc_strip(as.character(u[miss]))
    m <- regexpr(.SC_NUM_PREFIX_RE, s, perl = TRUE)
    hit <- !is.na(m) & m > 0
    if (any(hit)) v[miss[hit]] <- as.numeric(regmatches(s, m))
  }
  v
}

.sc_expand_year <- function(y, digits) ifelse(digits > 2, y, ifelse(y < 70, 2000L + y, 1900L + y))

.SC_DAYS_IN_MONTH <- c(31L, 28L, 31L, 30L, 31L, 30L, 31L, 31L, 30L, 31L, 30L, 31L)

# A real proleptic-Gregorian date with 1700 <= y <= 2200 (what Python's date() accepts inside the IDE's year window).
.sc_valid_ymd <- function(y, m, d) {
  ok <- !is.na(y) & !is.na(m) & !is.na(d) & m >= 1 & m <= 12 & d >= 1 & d <= 31 & y >= 1700 & y <= 2200
  if (any(ok)) {
    yy <- y[ok]; mm <- m[ok]
    dim <- .SC_DAYS_IN_MONTH[mm]
    dim[mm == 2 & ((yy %% 4 == 0 & yy %% 100 != 0) | yy %% 400 == 0)] <- 29L
    ok[ok] <- d[ok] <= dim
  }
  ok
}

# Days since 1970-01-01 of a civil date (Hinnant's algorithm; exact for the Gregorian calendar).
.sc_days_from_civil <- function(y, m, d) {
  y <- ifelse(m <= 2, y - 1, y)
  era <- floor(y / 400)
  yoe <- y - era * 400
  mp <- (m + 9) %% 12
  doy <- floor((153 * mp + 2) / 5) + d - 1
  era * 146097 + yoe * 365 + floor(yoe / 4) - floor(yoe / 100) + doy - 719468
}

# (year, month, day) of date-shaped strings under the IDE's rules, NA where not a date.
.sc_date_parts <- function(s, day_first = FALSE) {
  n <- length(s)
  y <- mo <- d <- rep(NA_integer_, n)
  s <- .sc_strip(as.character(s))
  pending <- !is.na(s) & nchar(s) >= 6 & nchar(s) <= 35 & grepl(.SC_DATE_START_RE, s, perl = TRUE)
  settle <- function(idx, yy, mm, dd) {
    ok <- .sc_valid_ymd(yy, mm, dd)
    y[idx[ok]] <<- yy[ok]; mo[idx[ok]] <<- mm[ok]; d[idx[ok]] <<- dd[ok]
    pending[idx] <<- FALSE
  }
  if (any(pending)) {
    idx <- which(pending)
    g <- .sc_capture(s[idx], .SC_P_ISO)
    miss <- is.na(g[, 1])
    if (any(miss)) g[miss, ] <- .sc_capture(s[idx[miss]], .SC_P_YSL)
    hit <- !is.na(g[, 1])
    if (any(hit)) settle(idx[hit], as.integer(g[hit, 1]), as.integer(g[hit, 2]), as.integer(g[hit, 3]))
  }
  if (any(pending)) {
    idx <- which(pending)
    g <- .sc_capture(s[idx], .SC_P_NUM)
    hit <- !is.na(g[, 1])
    if (any(hit)) {
      a <- as.integer(g[hit, 1]); b <- as.integer(g[hit, 2]); ys <- g[hit, 3]
      yy <- .sc_expand_year(as.integer(ys), nchar(ys))
      dd <- ifelse(a > 12 & b <= 12, a, ifelse(b > 12 & a <= 12, b, if (day_first) a else b))
      mm <- ifelse(a > 12 & b <= 12, b, ifelse(b > 12 & a <= 12, a, if (day_first) b else a))
      yy[a > 12 & b > 12] <- NA_integer_
      settle(idx[hit], yy, mm, dd)
    }
  }
  for (re in c(.SC_P_MON1, .SC_P_MON2)) {
    if (!any(pending)) break
    idx <- which(pending)
    g <- .sc_capture(s[idx], re)
    hit <- !is.na(g[, 1])
    if (any(hit)) {
      mon_txt <- if (re == .SC_P_MON1) g[hit, 1] else g[hit, 2]
      day_txt <- if (re == .SC_P_MON1) g[hit, 2] else g[hit, 1]
      ys <- g[hit, 3]
      settle(idx[hit], .sc_expand_year(as.integer(ys), nchar(ys)), unname(.SC_MONTHS[tolower(mon_txt)]), as.integer(day_txt))
    }
  }
  list(y = y, m = mo, d = d)
}

#' Parse date cells the way the IDE does
#'
#' ISO (`2024-01-05`, with an optional time and zone), `y/m/d`, `d/m/y` or
#' `m/d/y` with the "> 12" rule, `Jan 5, 2024`, `5 Jan 2024`; two-digit
#' years expand to 1970-2069; years outside 1700-2200 and impossible dates
#' are `NA`. Ambiguous numeric forms follow `day_first` (default month-first,
#' as the IDE). ISO timestamps keep their time; a zone offset is honoured
#' (converted to UTC).
#' @param x A character vector (a `Date` / `POSIXct` passes through).
#' @param day_first Read `05/06/2024` as 5 June (`TRUE`) or 6 May (`FALSE`).
#' @return A `POSIXct` vector in UTC, `NA` where the cell is not a date.
#' @examples
#' sc_parse_date(c("2024-01-05", "13/02/2024", "Jan 5, 2024", "5 Jan 24", "13/13/2024"))
#' @export
sc_parse_date <- function(x, day_first = FALSE) {
  if (inherits(x, "POSIXct")) return(x)
  if (inherits(x, "Date")) return(.POSIXct(as.numeric(x) * 86400, tz = "UTC"))
  n <- length(x)
  secs <- rep(NA_real_, n)
  if (!.sc_is_text(x)) return(.POSIXct(secs, tz = "UTC"))
  s <- .sc_strip(as.character(x))
  ok <- !is.na(s) & nchar(s) >= 6 & nchar(s) <= 35 & grepl(.SC_DATE_START_RE, s, perl = TRUE)
  if (!any(ok)) return(.POSIXct(secs, tz = "UTC"))
  idx <- which(ok)
  g <- .sc_capture(s[idx], .SC_ISO_TIMESTAMP_RE)
  ts <- !is.na(g[, 1])
  if (any(ts)) {
    y <- as.integer(g[ts, 1]); mo <- as.integer(g[ts, 2]); d <- as.integer(g[ts, 3])
    hh <- as.integer(g[ts, 4]); mi <- as.integer(g[ts, 5])
    ss <- ifelse(nzchar(g[ts, 6]), suppressWarnings(as.integer(g[ts, 6])), 0L)
    frac <- ifelse(nzchar(g[ts, 7]), suppressWarnings(as.numeric(paste0("0.", g[ts, 7]))), 0)
    zone <- g[ts, 8]
    offset <- rep(0, sum(ts))
    z <- nzchar(zone) & zone != "Z"
    if (any(z)) {
      zs <- gsub(":", "", zone[z], fixed = TRUE)
      offset[z] <- ifelse(startsWith(zs, "-"), -1, 1) * (as.integer(substr(zs, 2, 3)) * 3600 + as.integer(substr(zs, 4, 5)) * 60)
    }
    valid <- .sc_valid_ymd(y, mo, d) & hh <= 23 & mi <= 59 & ss <= 59
    val <- rep(NA_real_, sum(ts))
    if (any(valid)) val[valid] <- .sc_days_from_civil(y[valid], mo[valid], d[valid]) * 86400 + hh[valid] * 3600 + mi[valid] * 60 + ss[valid] + frac[valid] - offset[valid]
    secs[idx[ts]] <- val
  }
  rest <- idx[!ts]
  if (length(rest)) {
    p <- .sc_date_parts(s[rest], day_first)
    hit <- !is.na(p$y)
    if (any(hit)) secs[rest[hit]] <- .sc_days_from_civil(p$y[hit], p$m[hit], p$d[hit]) * 86400
  }
  .POSIXct(secs, tz = "UTC")
}

.sc_is_date_shaped <- function(s) {
  n <- length(s)
  out <- logical(n)
  s <- as.character(s)
  cand <- which(!is.na(s) & grepl(.SC_DATE_START_RE, .sc_strip(s), perl = TRUE))
  if (!length(cand)) return(out)
  s <- s[cand]
  g <- .sc_capture(s, .SC_ISO_TIMESTAMP_RE)
  ts <- !is.na(g[, 1])
  res <- logical(length(s))
  if (any(ts)) res[ts] <- .sc_valid_ymd(as.integer(g[ts, 1]), as.integer(g[ts, 2]), as.integer(g[ts, 3]))
  if (any(!ts)) res[!ts] <- !is.na(.sc_date_parts(s[!ts], FALSE)$y)
  out[cand] <- res
  out
}

# (day-first, month-first) evidence of numeric date cells, weighted by their counts.
.sc_day_first_votes <- function(u, cnt = rep(1L, length(u))) {
  g <- .sc_capture(.sc_strip(as.character(u)), .SC_P_NUM)
  a <- suppressWarnings(as.integer(g[, 1])); b <- suppressWarnings(as.integer(g[, 2]))
  ok <- !is.na(a) & !is.na(b)
  c(sum(cnt[ok & a > 12 & b <= 12]), sum(cnt[ok & b > 12 & a <= 12]))
}

#' Does a column read day-first?
#'
#' `TRUE` when the unambiguous numeric cells (`a/b/y` with a > 12 or b > 12)
#' say the day comes first; ties give month-first.
#' @param values Character vector of date cells.
#' @return A logical scalar.
#' @examples
#' sc_infer_day_first(c("13/01/2024", "14/01/2024", "05/06/2024"))
#' @export
sc_infer_day_first <- function(values) {
  v <- .sc_day_first_votes(values)
  v[1] > v[2]
}

.sc_levenshtein_at_most <- function(a, b, mx) {
  if (abs(nchar(a) - nchar(b)) > mx) return(NULL)
  d <- as.integer(utils::adist(a, b)[1, 1])
  if (d <= mx) d else NULL
}

.sc_differs_only_in_code_token <- function(a, b) {
  ta <- strsplit(.sc_strip(a), "(*UCP)\\s+", perl = TRUE)[[1]]
  tb <- strsplit(.sc_strip(b), "(*UCP)\\s+", perl = TRUE)[[1]]
  if (length(ta) != length(tb)) return(FALSE)
  diff <- which(ta != tb)
  length(diff) == 1 && nchar(ta[diff]) <= 2 && nchar(tb[diff]) <= 2
}

# top: list(values = character, counts = integer) of the most common labels.
.sc_near_duplicate <- function(top, non_missing) {
  k <- min(12L, length(top$values))
  if (k < 2) return(NULL)
  vals <- top$values[seq_len(k)]; cnts <- top$counts[seq_len(k)]
  min_count <- max(4, round(non_missing * 0.002))
  best <- NULL
  for (i in seq_len(k - 1)) {
    for (j in (i + 1):k) {
      va <- vals[i]; ca <- cnts[i]; vb <- vals[j]; cb <- cnts[j]
      if (ca < min_count || cb < min_count || ca == cb) next
      al <- tolower(va); bl <- tolower(vb)
      if (al == bl) next
      min_len <- min(nchar(al), nchar(bl))
      if (min_len < 4) next
      max_dist <- if (min_len >= 8) 2 else 1
      if (is.null(.sc_levenshtein_at_most(al, bl, max_dist))) next
      if (.sc_differs_only_in_code_token(al, bl)) next
      hit <- if (ca < cb) list(from = va, to = vb, count = ca) else list(from = vb, to = va, count = cb)
      if (is.null(best) || hit$count > best$count) best <- hit
    }
  }
  best
}

# ── column-wise application helpers ─────────────────────────────────────────

# The "string cells" of a text column are its non-missing cells that are not
# strictly numeric strings: those are numbers to Scelo (typed at import), and
# pandas holds them as numbers inside the object column, where they are
# excluded too. Everything below works on the column's uniques.

# Facts about one text column, computed once from its uniques: the string
# uniques u (stable order of first appearance) with their counts, and their
# stripped and lower-cased forms.
.sc_str_info <- function(col) {
  if (!.sc_is_text(col)) return(list(u = character(), cnt = integer(), st = character(), lo = character(), type = sc_column_type(col)))
  x <- as.character(col)
  ux <- unique(x)
  idx <- match(x, ux)
  cnt_all <- tabulate(idx, length(ux))
  isnum <- !is.na(.sc_num_or_na(ux))
  keep <- !is.na(ux) & !isnum
  u <- ux[keep]
  st <- .sc_strip(u)
  list(u = u, cnt = cnt_all[keep], st = st, lo = tolower(st), type = .sc_text_type(x, ux, cnt_all, isnum, blank_missing = is.character(col)))
}

# sc_column_type() of a text column from its uniques: the same rule (80 %
# strictly numeric strings; else a strided probe of up to 200 cells, at least
# 8, 80 % unambiguous ISO dates), without rescanning every cell. "" is a
# missing cell in a character column but a present level in a factor, as in
# .sc_is_missing().
.sc_text_type <- function(x, ux, cnt_all, isnum, blank_missing = TRUE) {
  present <- !is.na(ux) & (!blank_missing | ux != "")
  n_present <- sum(cnt_all[present])
  if (!n_present) return("string")
  if (sum(cnt_all[isnum]) / n_present >= 0.8) return("number")
  strs <- x[!is.na(x) & (!blank_missing | x != "")]
  stride <- max(1L, length(strs) %/% 200L)
  probe <- utils::head(strs[seq(1, length(strs), by = stride)], 200)
  if (length(probe) >= 8 && sum(!is.na(.sc_date_year(probe))) / length(probe) >= 0.8) return("date")
  "string"
}

.sc_top_values <- function(info, n = 8L) {
  o <- order(-info$cnt)
  o <- o[seq_len(min(n, length(o)))]
  list(values = info$u[o], counts = info$cnt[o])
}

# Map fn over the string cells of a text column via its uniques; returns character.
.sc_map_strings <- function(col, fn) {
  if (!.sc_is_text(col)) return(col)
  x <- as.character(col)
  ux <- unique(x)
  str_u <- !is.na(ux) & is.na(.sc_num_or_na(ux))
  if (!any(str_u)) return(x)
  vals <- ux
  vals[str_u] <- fn(ux[str_u])
  vals[match(x, ux)]
}

# The column's cells as numbers where they are numbers (numeric columns, strictly numeric strings), else NA.
.sc_numeric_cells <- function(col) {
  if (is.numeric(col)) return(as.numeric(col))
  if (.sc_is_text(col)) return(.sc_num_or_na(as.character(col)))
  rep(NA_real_, length(col))
}

# A text column to numbers: numeric strings as they are, string cells through fn (via uniques).
.sc_parse_numeric_column <- function(col, fn) {
  if (!.sc_is_text(col)) return(.sc_numeric_cells(col))
  x <- as.character(col)
  ux <- unique(x)
  v <- .sc_num_or_na(ux)
  str_u <- !is.na(ux) & is.na(v)
  if (any(str_u)) v[str_u] <- fn(ux[str_u])
  v[match(x, ux)]
}

# Scelo's "missing" cell, exactly as .sc_is_missing() (NA, or "" in a
# character column), with the string test only run on character vectors so
# a Date column is not coerced to text on the way.
.sc_missing_mask <- function(col) if (is.character(col)) is.na(col) | col == "" else is.na(col)

# Exact duplicate rows, three times faster than duplicated.data.frame() and
# with the same equality (NA and NaN distinct, -0 equal to 0): each column is
# coded by match() against its uniques and the codes are hashed together.
.sc_duplicated_rows <- function(df) {
  if (!ncol(df) || !nrow(df)) return(rep(FALSE, nrow(df)))
  codes <- lapply(df, function(col) match(col, unique(col)))
  if (length(codes) == 1) return(duplicated(codes[[1]]))
  duplicated(do.call(paste, c(codes, sep = "\r")))
}

# Insert a column at position `at` (1-based).
.sc_insert_column <- function(df, at, name, values) {
  n <- ncol(df)
  df[[name]] <- values
  if (at <= n) df <- df[c(seq_len(at - 1L), n + 1L, at:n)]
  df
}

# ── individual ops (each returns a new frame) ─────────────────────────────

#' Individual cleaning ops
#'
#' Each op is one row of the cleaning banner, as a function from a data
#' frame to a data frame. `sc_fix_encoding()` repairs UTF-8 / Latin-1
#' mojibake ("Ã©" becomes "é"), NBSP to space, and drops BOM,
#' zero-width and soft-hyphen characters; `sc_trim()` strips leading /
#' trailing whitespace; `sc_collapse_ws()` collapses runs of internal
#' whitespace to one space; `sc_missing_tokens()` nulls the missing markers
#' ("N/A", "?", "-", "TBD", "#N/A", "null", ... case-insensitive, trimmed);
#' `sc_parse_numbers()` turns money / percent / thousands-separated strings
#' into numbers (columns default to those at least 80 % parseable);
#' `sc_parse_dates()` parses mixed-format date strings into `Date` (day-first
#' inferred per column from the unambiguous cells; time of day is dropped,
#' see [sc_parse_date()] to keep it); `sc_booleans()` standardises yes / no /
#' Y / N / true / false / on / off into a logical column; `sc_sentinels()`
#' nulls legacy numeric sentinels (-999, 9999, -1 ...) when they sit at
#' least 5 IQR outside the column's body and recur at least 3 times;
#' `sc_coerce_numeric()` turns number-typed columns with string residue
#' numeric, keeping the numeric prefix ("6+" becomes 6) and nulling the
#' digit-free rest; `sc_recode()` replaces one exact value in one column;
#' `sc_future_years()` nulls integer years after `max_year` in year-named
#' numeric columns; `sc_impute()` fills missing cells (numeric: median,
#' categorical: mode) with a `was_missing_<col>` indicator inserted right
#' after the column; `sc_cap_outliers()` winsorises numeric columns to the
#' Tukey fences; `sc_dedupe()` drops exact duplicate rows; `sc_drop_empty()`
#' drops columns more than `threshold` missing; `sc_drop_constant()` drops
#' single-valued columns; `sc_lowercase()` lower-cases string columns whose
#' top values differ only by case; `sc_snake_names()` snake_cases the headers
#' (abandoned entirely on any collision).
#'
#' `sc_impute()` follows the IDE's refusal rules in `auto` mode: nothing
#' missing, fewer than 4 known values, over 95 % missing, a date column, an
#' identifier-like column (unique > max(20, 2 % of present)) or no value
#' common enough to be a mode (< 2 %) are skipped rather than invented.
#' `sc_cap_outliers()` skips year columns (a calendar fact, not a
#' distribution), identifier-like columns (all distinct and id-named) and
#' columns with no spread when no columns are named. Strictly numeric
#' strings are numbers to Scelo and are never treated as text by these ops.
#'
#' @param df A data frame.
#' @param columns Columns to touch; `NULL` picks them by the op's rule.
#' @param tokens Missing markers to null (default [SC_MISSING_TOKENS]).
#' @param day_first Day-first reading for ambiguous dates; `NULL` infers it per column.
#' @param values Sentinel values to null; `NULL` applies the IDE's rule.
#' @param column One column name.
#' @param from,to The exact value to replace and its replacement.
#' @param max_year Years after this are nulled (default: this year).
#' @param strategy `auto` / `median` / `mean` / `mode` / `value`.
#' @param indicator Add the `was_missing_<col>` indicator column.
#' @param value The fill for `strategy = "value"`.
#' @param k Tukey fence multiplier (1.5).
#' @param threshold Drop columns with more than this share missing.
#' @return A data frame (never a `scelo_table`; [sc_clean()] wraps the plan).
#' @examples
#' d <- sc_sample("dirty")
#' head(sc_parse_numbers(d)$premium_zar)
#' sc_snake_names(d)[1:2, ]
#' @export
sc_fix_encoding <- function(df, columns = NULL) {
  out <- df
  for (c in columns %||% names(out)) out[[c]] <- .sc_map_strings(out[[c]], .sc_fix_encoding_str)
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_trim <- function(df, columns = NULL) {
  out <- df
  for (c in columns %||% names(out)) out[[c]] <- .sc_map_strings(out[[c]], .sc_strip)
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_collapse_ws <- function(df, columns = NULL) {
  out <- df
  for (c in columns %||% names(out)) out[[c]] <- .sc_map_strings(out[[c]], .sc_collapse_ws_str)
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_missing_tokens <- function(df, columns = NULL, tokens = NULL) {
  toks <- if (is.null(tokens)) SC_MISSING_TOKENS else tolower(tokens)
  out <- df
  for (c in columns %||% names(out)) out[[c]] <- .sc_map_strings(out[[c]], function(u) .sc_missing_tokens_str(u, toks))
  out
}

.sc_numeric_share <- function(info) .sc_share(info, function(st) !is.na(sc_parse_number(st)))

#' @rdname sc_fix_encoding
#' @export
sc_parse_numbers <- function(df, columns = NULL) {
  out <- df
  cols <- columns %||% names(out)[vapply(out, function(col) .sc_numeric_share(.sc_str_info(col)) >= 0.8, logical(1))]
  for (c in cols) out[[c]] <- .sc_parse_numeric_column(out[[c]], sc_parse_number)
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_parse_dates <- function(df, columns = NULL, day_first = NULL) {
  out <- df
  cols <- columns %||% names(out)[vapply(out, function(col) .sc_is_text(col) && sc_column_type(col) != "number" && .sc_share(.sc_str_info(col), .sc_is_date_shaped) >= 0.8, logical(1))]
  for (c in cols) {
    col <- out[[c]]
    if (inherits(col, c("Date", "POSIXt"))) next
    res <- rep(NA_real_, length(col))
    if (.sc_is_text(col)) {
      x <- as.character(col)
      ux <- unique(x)
      idx <- match(x, ux)
      str_u <- !is.na(ux) & is.na(.sc_num_or_na(ux))
      if (any(str_u)) {
        dfst <- if (is.null(day_first)) {
          v <- .sc_day_first_votes(ux[str_u], tabulate(idx, length(ux))[str_u])
          v[1] > v[2]
        } else day_first
        vals <- rep(NA_real_, length(ux))
        vals[str_u] <- floor(as.numeric(sc_parse_date(ux[str_u], dfst)) / 86400)
        res <- vals[idx]
      }
    }
    out[[c]] <- .Date(res)
  }
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_booleans <- function(df, columns = NULL) {
  out <- df
  cols <- columns %||% names(out)[vapply(out, function(col) .sc_bool_candidate(.sc_str_info(col)), logical(1))]
  for (c in cols) {
    col <- out[[c]]
    if (is.logical(col)) next
    res <- rep(NA, length(col))
    if (.sc_is_text(col)) {
      x <- as.character(col)
      ux <- unique(x)
      str_u <- !is.na(ux) & is.na(.sc_num_or_na(ux))
      if (any(str_u)) {
        t <- tolower(.sc_strip(ux[str_u]))
        v <- rep(NA, length(ux))
        v[str_u] <- ifelse(t %in% SC_MISSING_TOKENS, NA, ifelse(t %in% SC_TRUE_TOKENS, TRUE, ifelse(t %in% SC_FALSE_TOKENS, FALSE, NA)))
        res <- v[match(x, ux)]
      }
    }
    out[[c]] <- res
  }
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_sentinels <- function(df, columns = NULL, values = NULL) {
  out <- df
  for (c in columns %||% names(out)) {
    col <- out[[c]]
    if (!is.numeric(col)) next
    vals <- if (is.null(values)) .sc_sentinel_values(col) else as.numeric(values)
    if (length(vals)) {
      col[col %in% vals] <- NA
      out[[c]] <- col
    }
  }
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_coerce_numeric <- function(df, columns = NULL) {
  out <- df
  cols <- columns %||% names(out)[vapply(out, function(col) .sc_is_text(col) && sc_column_type(col) == "number", logical(1))]
  for (c in cols) out[[c]] <- .sc_parse_numeric_column(out[[c]], .sc_coerce_numeric_value)
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_recode <- function(df, column, from, to) {
  out <- df
  col <- out[[column]]
  hit <- !is.na(col) & col == from
  if (any(hit)) {
    if (is.factor(col)) col <- as.character(col)
    col[hit] <- to
    out[[column]] <- col
  }
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_future_years <- function(df, columns = NULL, max_year = NULL) {
  cut <- if (is.null(max_year)) as.integer(format(Sys.Date(), "%Y")) else max_year
  out <- df
  cols <- columns %||% names(out)[vapply(names(out), function(c) grepl(.SC_YEAR_COL_RE, c, ignore.case = TRUE) && is.numeric(out[[c]]), logical(1))]
  for (c in cols) {
    v <- out[[c]]
    v[!is.na(v) & v > cut & v %% 1 == 0] <- NA
    out[[c]] <- v
  }
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_impute <- function(df, columns = NULL, strategy = "auto", indicator = TRUE, value = NULL) {
  out <- df
  cols <- columns %||% names(out)
  existing <- names(out)
  for (c in cols) {
    col <- out[[c]]
    miss <- .sc_missing_mask(col)
    n_missing <- sum(miss)
    if (n_missing == 0) next
    present <- col[!miss]
    ctype <- sc_column_type(col)
    if (strategy == "auto" && !is.null(.sc_impute_skip(col, present, n_missing, ctype))) next
    if (strategy == "value") {
      fill <- value
    } else if (strategy %in% c("median", "mean") || (strategy == "auto" && ctype == "number")) {
      nums <- .sc_numeric_cells(present)
      nums <- nums[!is.na(nums)]
      if (!length(nums)) next
      fill <- if (strategy == "mean") mean(nums) else stats::median(nums)
    } else {
      vc <- .sc_value_counts(if (is.factor(present)) as.character(present) else present)
      if (!length(vc$values)) next
      fill <- vc$values[1]
    }
    if (indicator) {
      snake <- sc_snake_case(c)
      name <- paste0("was_missing_", if (is.na(snake)) c else snake)
      if (!name %in% existing) {
        out <- .sc_insert_column(out, match(c, names(out)) + 1L, name, miss)
        existing <- c(existing, name)
      }
    }
    col <- out[[c]]
    if (is.factor(col)) col <- as.character(col)
    col[miss] <- fill
    out[[c]] <- col
  }
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_cap_outliers <- function(df, columns = NULL, k = 1.5) {
  out <- df
  for (c in columns %||% names(out)) {
    col <- out[[c]]
    if (!is.numeric(col)) next
    if (is.null(columns) && !is.null(.sc_cap_skip(col, c))) next
    v <- as.numeric(col)
    if (!any(is.finite(v))) next
    qs <- stats::quantile(v[is.finite(v)], c(0.25, 0.75), type = 7, names = FALSE)
    lo <- qs[1] - k * (qs[2] - qs[1]); hi <- qs[2] + k * (qs[2] - qs[1])
    if (hi <= lo) next
    out[[c]] <- pmin(pmax(v, lo), hi)
  }
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_dedupe <- function(df, columns = NULL) {
  keep <- !.sc_duplicated_rows(if (length(columns)) df[columns] else df)
  out <- df[keep, , drop = FALSE]
  rownames(out) <- NULL
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_drop_empty <- function(df, threshold = 0.95) {
  miss <- vapply(df, function(col) mean(.sc_missing_mask(col)), numeric(1))
  cols <- names(df)[miss > threshold]
  if (!length(cols) || length(cols) == ncol(df)) return(df)
  df[setdiff(names(df), cols)]
}

#' @rdname sc_fix_encoding
#' @export
sc_drop_constant <- function(df) {
  cols <- names(df)[vapply(df, .sc_is_constant, logical(1))]
  if (!length(cols) || length(cols) == ncol(df)) return(df)
  df[setdiff(names(df), cols)]
}

.sc_is_constant <- function(col) {
  present <- col[!.sc_missing_mask(col)]
  length(present) > 0 && length(unique(present)) == 1
}

#' @rdname sc_fix_encoding
#' @export
sc_lowercase <- function(df, columns = NULL) {
  out <- df
  cols <- columns %||% names(out)[vapply(out, function(col) .sc_case_merges(.sc_str_info(col)) > 0, logical(1))]
  for (c in cols) out[[c]] <- .sc_map_strings(out[[c]], tolower)
  out
}

#' @rdname sc_fix_encoding
#' @export
sc_snake_names <- function(df) {
  mapping <- .sc_snake_mapping(names(df))
  if (is.null(mapping) || !length(mapping)) return(df)
  nm <- names(df)
  nm[match(names(mapping), nm)] <- unname(mapping)
  names(df) <- nm
  df
}

# column → snake_case name for the headers that change; NULL on any collision.
.sc_snake_mapping <- function(cols) {
  mapping <- character()
  for (c in cols) {
    s <- sc_snake_case(c)
    if (is.na(s)) next
    if (s %in% cols || s %in% mapping) return(NULL)
    mapping[c] <- s
  }
  mapping
}

# ── analyser internals ──────────────────────────────────────────────────────

.sc_value_counts <- function(x) {
  u <- unique(x)
  cnt <- tabulate(match(x, u), length(u))
  o <- order(-cnt)
  list(values = u[o], counts = cnt[o])
}

# Share of candidate string cells (non-missing-token) satisfying pred (on the stripped uniques); 0 when fewer than 4 candidates.
.sc_share <- function(info, pred) {
  if (!length(info$u)) return(0)
  cand <- nzchar(info$st) & !(info$lo %in% SC_MISSING_TOKENS)
  n <- sum(info$cnt[cand])
  if (n < 4) return(0)
  sum(info$cnt[cand & pred(info$st)]) / n
}

.sc_bool_candidate <- function(info) {
  if (!length(info$u)) return(FALSE)
  cand <- nzchar(info$st) & !(info$lo %in% SC_MISSING_TOKENS)
  n <- sum(info$cnt[cand])
  if (n < 4) return(FALSE)
  is_t <- cand & info$lo %in% SC_TRUE_TOKENS
  is_f <- cand & info$lo %in% SC_FALSE_TOKENS
  t <- sum(info$cnt[is_t]); f <- sum(info$cnt[is_f])
  other <- n - t - f
  noncanon <- sum(info$cnt[(is_t | is_f) & !(info$u %in% c("true", "false"))])
  t > 0 && f > 0 && other / n <= 0.05 && noncanon > 0
}

.sc_sentinel_values <- function(col) {
  v <- .sc_numeric_cells(col)
  v <- v[!is.na(v)]
  if (!length(v)) return(numeric())
  qs <- stats::quantile(v, c(0.25, 0.75), type = 7, names = FALSE)
  iqr <- qs[2] - qs[1]
  if (!is.finite(iqr) || iqr <= 0) return(numeric())
  lo_cut <- qs[1] - 5 * iqr; hi_cut <- qs[2] + 5 * iqr
  hits <- v[v %in% SC_NUMERIC_SENTINELS]
  if (!length(hits)) return(numeric())
  vc <- .sc_value_counts(hits)
  keep <- vc$counts >= 3 & !(lo_cut < vc$values & vc$values < hi_cut)
  vc$values[keep]
}

.sc_case_merges <- function(info) {
  if (length(info$u) < 2) return(0L)
  top <- .sc_top_values(info, 8L)$values
  g <- table(tolower(top))
  as.integer(sum(g[g > 1] - 1L))
}

.sc_impute_skip <- function(col, present, n_missing, ctype = NULL) {
  count <- length(col)
  n_present <- length(present)
  if (n_present < 4) return("too few known values to learn a fill from")
  if (n_missing / count > 0.95) return("over 95% missing: a fill would be inventing the column")
  t <- ctype %||% sc_column_type(col)
  if (t == "date") return("a date has no defensible constant fill")
  if (t == "number") return(NULL)
  uniq <- length(unique(present))
  if (uniq > max(20, n_present * 0.02)) return("reads as an identifier or free text")
  vc <- .sc_value_counts(present)
  if (!length(vc$values) || vc$counts[1] / n_present < 0.02) return("no value is common enough to stand as the mode")
  NULL
}

.sc_cap_skip <- function(col, name) {
  if (grepl(.SC_YEAR_COL_RE, name, ignore.case = TRUE)) return("a year is a calendar fact, not a distribution to winsorise")
  v <- .sc_numeric_cells(col)
  v <- v[!is.na(v)]
  if (!length(v)) return("no numeric values")
  qs <- stats::quantile(v, c(0.25, 0.75), type = 7, names = FALSE)
  iqr <- qs[2] - qs[1]
  if (iqr <= 0) return("Q1 equals Q3, so both fences land on one value")
  lo <- qs[1] - 1.5 * iqr; hi <- qs[2] + 1.5 * iqr
  if (!any(v < lo | v > hi)) return("nothing sits outside the fences")
  if (length(unique(v)) == length(v) && grepl(.SC_ID_NAME_RE, name, perl = TRUE, ignore.case = TRUE)) return("every value is distinct and the name reads as an identifier")
  NULL
}

.sc_outside_fences <- function(col) {
  v <- .sc_numeric_cells(col)
  v <- v[!is.na(v)]
  if (!length(v)) return(0L)
  qs <- stats::quantile(v, c(0.25, 0.75), type = 7, names = FALSE)
  lo <- qs[1] - 1.5 * (qs[2] - qs[1]); hi <- qs[2] + 1.5 * (qs[2] - qs[1])
  sum(v < lo | v > hi)
}

# One pass of the IDE's analyser: the ops the data asks for, with evidence.
# One scan per text column (its uniques), every rule reads from it.
.sc_analyse <- function(df) {
  ops <- list()
  add <- function(key, cells, columns = character(), why, recode = NULL) {
    ops[[length(ops) + 1L]] <<- list(op = key, safe = key %in% SC_SAFE_OPS, cells = as.integer(cells), columns = as.character(columns), why = why, recode = recode)
  }
  cols <- names(df)
  str_cols <- cols[vapply(df, .sc_is_text, logical(1))]
  info <- lapply(str_cols, function(c) .sc_str_info(df[[c]]))
  names(info) <- str_cols
  types <- vapply(str_cols, function(c) info[[c]]$type, character(1))
  year_now <- as.integer(format(Sys.Date(), "%Y"))
  memo <- new.env(parent = emptyenv())
  lazy <- function(c, what, fn) {
    key <- paste0(what, "\r", c)
    if (is.null(memo[[key]])) memo[[key]] <- fn(info[[c]])
    memo[[key]]
  }
  num_ok <- function(c) lazy(c, "num", function(i) !is.na(sc_parse_number(i$st)))
  date_ok <- function(c) lazy(c, "date", function(i) .sc_is_date_shaped(i$st))
  count <- function(c, flag) as.integer(sum(info[[c]]$cnt[flag]))
  count_all <- function(fn) sum(vapply(str_cols, function(c) count(c, fn(info[[c]])), integer(1)))

  # table-wide string hygiene
  n_enc <- count_all(function(i) grepl(.SC_ENCODING_NOISE_RE, i$st, perl = TRUE) | grepl(.SC_MOJIBAKE_ANY_RE, i$u, perl = TRUE))
  if (n_enc) add("fix-encoding", n_enc, why = "mojibake, NBSP or zero-width characters")
  n_trim <- count_all(function(i) i$u != i$st)
  if (n_trim) add("trim", n_trim, why = "leading / trailing whitespace")
  n_ws <- count_all(function(i) grepl(.SC_INTERNAL_WS_RE, i$st, perl = TRUE))
  if (n_ws) add("collapse-whitespace", n_ws, why = "runs of internal whitespace")
  found <- integer()
  for (c in str_cols) {
    i <- info[[c]]
    tok <- nzchar(i$st) & i$lo %in% SC_MISSING_TOKENS
    for (j in which(tok)) found[i$st[j]] <- (if (is.na(found[i$st[j]])) 0L else found[i$st[j]]) + i$cnt[j]
  }
  if (length(found)) add("missing-tokens", sum(found), why = paste0("missing markers: ", paste(utils::head(sort(names(found), method = "radix"), 12), collapse = ", ")))

  # typed parses
  claimed <- character()
  num_cols <- str_cols[vapply(str_cols, function(c) types[[c]] == "string" && .sc_share(info[[c]], function(st) num_ok(c)) >= 0.8, logical(1))]
  if (length(num_cols)) {
    claimed <- c(claimed, num_cols)
    add("parse-numeric", sum(vapply(num_cols, function(c) count(c, num_ok(c)), integer(1))), num_cols, "≥ 80 % of cells parse as numbers")
  }
  date_cols <- str_cols[vapply(str_cols, function(c) !(c %in% claimed) && types[[c]] != "number" && .sc_share(info[[c]], function(st) date_ok(c)) >= 0.8, logical(1))]
  if (length(date_cols)) {
    claimed <- c(claimed, date_cols)
    add("parse-dates", sum(vapply(date_cols, function(c) count(c, date_ok(c)), integer(1))), date_cols, "≥ 80 % of cells are date-shaped")
  }
  bool_cols <- str_cols[vapply(str_cols, function(c) !(c %in% claimed) && .sc_bool_candidate(info[[c]]), logical(1))]
  if (length(bool_cols)) {
    claimed <- c(claimed, bool_cols)
    add("standardise-booleans", sum(vapply(bool_cols, function(c) count(c, info[[c]]$lo %in% SC_TRUE_TOKENS | info[[c]]$lo %in% SC_FALSE_TOKENS), integer(1))), bool_cols, "two boolean spellings, ≤ 5 % other values")
  }
  sent_cols <- character(); sent_cells <- 0L
  for (c in cols) {
    if (is.numeric(df[[c]])) {
      vals <- .sc_sentinel_values(df[[c]])
      if (length(vals)) {
        sent_cols <- c(sent_cols, c)
        sent_cells <- sent_cells + sum(df[[c]] %in% vals)
      }
    }
  }
  if (length(sent_cols)) add("replace-numeric-sentinels", sent_cells, sent_cols, "recurring sentinel values ≥ 5 IQR outside the body")
  coerce_cols <- str_cols[types[str_cols] == "number"]
  if (length(coerce_cols)) {
    add("coerce-numeric", sum(vapply(coerce_cols, function(c) sum(info[[c]]$cnt), integer(1))), coerce_cols, "number-typed columns holding string residue")
    claimed <- c(claimed, coerce_cols)
  }

  # recode near-duplicate labels (at most one per plan)
  best <- NULL
  for (c in str_cols) {
    if (!length(info[[c]]$u)) next
    hit <- .sc_near_duplicate(.sc_top_values(info[[c]], 8L), sum(!.sc_missing_mask(df[[c]])))
    if (!is.null(hit) && (is.null(best) || hit$count > best$count)) best <- c(list(column = c), hit)
  }
  if (!is.null(best)) {
    add("recode-value", best$count, best$column, sprintf('"%s" looks like a misspelling of "%s"', best$from, best$to),
        recode = list(column = best$column, from = best$from, to = best$to))
  }

  # future years
  fy_cols <- character(); fy_cells <- 0L
  for (c in cols) {
    if (is.numeric(df[[c]]) && grepl(.SC_YEAR_COL_RE, c, ignore.case = TRUE)) {
      v <- df[[c]][!is.na(df[[c]])]
      if (length(v) && min(v) >= 1900 && max(v) <= 2100 && max(v) > year_now) {
        n <- sum(v > year_now & v %% 1 == 0)
        if (n) {
          fy_cols <- c(fy_cols, c)
          fy_cells <- fy_cells + n
        }
      }
    }
  }
  if (length(fy_cols)) add("null-future-years", fy_cells, fy_cols, sprintf("years after %d", year_now))

  # duplicates
  n_dupes <- sum(.sc_duplicated_rows(df))
  if (n_dupes) add("drop-duplicates", n_dupes, why = "exact duplicate rows")

  # empty / constant columns
  miss_share <- vapply(df, function(col) mean(.sc_missing_mask(col)), numeric(1))
  empty_cols <- cols[miss_share > 0.95]
  if (length(empty_cols) && length(empty_cols) < length(cols)) add("drop-empty-cols", length(empty_cols), empty_cols, "> 95 % missing")
  const_cols <- cols[vapply(df, .sc_is_constant, logical(1))]
  if (length(const_cols) && length(const_cols) < length(cols)) add("drop-constant-cols", length(const_cols), const_cols, "single-valued")

  # lower-case categoricals
  merges <- vapply(str_cols, function(c) .sc_case_merges(info[[c]]), integer(1))
  lc_cols <- str_cols[merges > 0]
  if (length(lc_cols)) add("lowercase-categoricals", sum(merges[merges > 0]), lc_cols, "labels differing only by case")

  # learned ops, held back on columns unsettled by this pass
  unsettled <- character()
  for (o in ops) {
    if (o$op == "missing-tokens") unsettled <- c(unsettled, str_cols)
    unsettled <- c(unsettled, o$columns)
  }
  cap_cols <- cols[vapply(cols, function(c) !(c %in% unsettled) && is.numeric(df[[c]]) && is.null(.sc_cap_skip(df[[c]], c)), logical(1))]
  if (length(cap_cols)) add("cap-outliers", sum(vapply(cap_cols, function(c) .sc_outside_fences(df[[c]]), integer(1))), cap_cols, "values outside the Tukey fences")
  imp_cols <- character(); imp_cells <- 0L
  for (c in cols) {
    if (c %in% unsettled) next
    miss <- .sc_missing_mask(df[[c]])
    n_missing <- sum(miss)
    if (n_missing == 0 || !is.null(.sc_impute_skip(df[[c]], df[[c]][!miss], n_missing, if (c %in% str_cols) info[[c]]$type else NULL))) next
    imp_cols <- c(imp_cols, c)
    imp_cells <- imp_cells + n_missing
  }
  if (length(imp_cols)) add("impute-missing", imp_cells, imp_cols, "median (numeric) / mode (categorical) fills with was_missing_* indicators")

  # snake-case headers
  mapping <- .sc_snake_mapping(cols)
  if (!is.null(mapping) && length(mapping)) add("rename-snake-case", length(mapping), names(mapping), "headers with spaces, punctuation or CamelCase")
  ops
}

.sc_plan_table <- function(ops) {
  if (!length(ops)) return(data.frame(op = character(), title = character(), safe = logical(), cells = integer(), columns = character(), why = character(), stringsAsFactors = FALSE))
  data.frame(
    op = vapply(ops, function(o) o$op, character(1)),
    title = vapply(ops, function(o) unname(.SC_OP_TITLES[[o$op]]), character(1)),
    safe = vapply(ops, function(o) o$safe, logical(1)),
    cells = vapply(ops, function(o) o$cells, integer(1)),
    columns = vapply(ops, function(o) paste(o$columns, collapse = ", "), character(1)),
    why = vapply(ops, function(o) o$why, character(1)),
    stringsAsFactors = FALSE
  )
}

#' What the data asks for: the cleaning plan
#'
#' One row per proposed cleaning op with its evidence (cells, columns, why)
#' and a `safe` flag. Safe ops are applied by `sc_clean(df)`; the rest only
#' by `sc_clean(df, "all")` or by naming them. Read it the way you would read
#' the IDE's banner.
#' @param df A data frame.
#' @return A `scelo_table` with `op`, `title`, `safe`, `cells`, `columns`, `why`.
#' @examples
#' sc_suggest(sc_sample("dirty"))
#' @export
sc_suggest <- function(df) {
  .sc_tool("sc_suggest", list(df = df), df, {
    ops <- .sc_analyse(df)
    t <- sc_table(.sc_plan_table(ops), title = sprintf("cleaning plan · %d op(s) · %s rows × %d cols", length(ops), .sc_fmt_n(nrow(df)), ncol(df)), stage = "soft")
    if (!length(ops)) {
      t <- sc_note(t, "Nothing to clean: no op found anything to do.")
    } else {
      n_safe <- sum(vapply(ops, function(o) o$safe, logical(1)))
      t <- sc_note(t, sprintf("%d safe op(s) run with sc_clean(df); %d need sc_clean(df, \"all\") or an explicit list.", n_safe, length(ops) - n_safe))
    }
    t
  })
}

.sc_rename <- function(c, snake_op) {
  if (!is.null(snake_op) && c %in% snake_op$columns) {
    s <- sc_snake_case(c)
    return(if (is.na(s)) c else s)
  }
  c
}

# Apply the enabled ops of a plan in the IDE's order; returns list(df, done = what-was-done lines).
# The four string-hygiene ops are fused into one pass over each column's
# uniques (the IDE does the same per row); each is a no-op on a strictly
# numeric string, so the fused result equals running them one after another.
.sc_apply_plan <- function(df, ops, enabled) {
  done <- character()
  out <- df
  by_key <- stats::setNames(ops, vapply(ops, function(o) o$op, character(1)))
  on <- function(key) if (key %in% enabled && key %in% names(by_key)) by_key[[key]] else NULL
  join <- function(x) paste(x, collapse = ", ")
  unparsed_note <- function(cols, before) {
    after <- vapply(cols, function(c) sum(is.na(out[[c]])), integer(1)) - before
    extra <- paste(sprintf("%s: %d unparseable → null", cols[after > 0], after[after > 0]), collapse = "; ")
    if (nzchar(extra)) sprintf(" (%s)", extra) else ""
  }
  hygiene <- list()
  for (step in list(list("fix-encoding", .sc_fix_encoding_str), list("trim", .sc_strip), list("collapse-whitespace", .sc_collapse_ws_str), list("missing-tokens", .sc_missing_tokens_str))) {
    o <- on(step[[1]])
    if (!is.null(o)) {
      hygiene[[step[[1]]]] <- step[[2]]
      done <- c(done, sprintf("%s: %s cells", .SC_OP_TITLES[[step[[1]]]], .sc_fmt_n(o$cells)))
    }
  }
  if (length(hygiene)) {
    chain <- function(u) { for (f in hygiene) u <- f(u); u }
    for (c in names(out)) out[[c]] <- .sc_map_strings(out[[c]], chain)
  }
  o <- on("recode-value")
  if (!is.null(o)) {
    r <- o$recode
    out <- sc_recode(out, r$column, r$from, r$to)
    done <- c(done, sprintf("recode `%s`: \"%s\" → \"%s\" (%d cells)", r$column, r$from, r$to, o$cells))
  }
  o <- on("standardise-booleans")
  if (!is.null(o)) {
    out <- sc_booleans(out, o$columns)
    done <- c(done, paste0("booleans: ", join(o$columns)))
  }
  o <- on("parse-dates")
  if (!is.null(o)) {
    before <- vapply(o$columns, function(c) sum(.sc_missing_mask(out[[c]])), integer(1))
    out <- sc_parse_dates(out, o$columns)
    done <- c(done, paste0("dates: ", join(o$columns), unparsed_note(o$columns, before)))
  }
  o <- on("parse-numeric")
  if (!is.null(o)) {
    before <- vapply(o$columns, function(c) sum(.sc_missing_mask(out[[c]])), integer(1))
    out <- sc_parse_numbers(out, o$columns)
    done <- c(done, paste0("numbers: ", join(o$columns), unparsed_note(o$columns, before)))
  }
  o <- on("coerce-numeric")
  if (!is.null(o)) {
    out <- sc_coerce_numeric(out, o$columns)
    done <- c(done, paste0("coerce numeric residue: ", join(o$columns)))
  }
  o <- on("replace-numeric-sentinels")
  if (!is.null(o)) {
    out <- sc_sentinels(out, o$columns)
    done <- c(done, sprintf("sentinels → null: %s (%d cells)", join(o$columns), o$cells))
  }
  o <- on("null-future-years")
  if (!is.null(o)) {
    out <- sc_future_years(out, o$columns)
    done <- c(done, sprintf("future years → null: %s (%d cells)", join(o$columns), o$cells))
  }
  o <- on("lowercase-categoricals")
  if (!is.null(o)) {
    out <- sc_lowercase(out, o$columns)
    done <- c(done, paste0("lower-case: ", join(o$columns)))
  }
  o <- on("drop-duplicates")
  if (!is.null(o)) {
    n0 <- nrow(out)
    out <- sc_dedupe(out)
    done <- c(done, sprintf("duplicates dropped: %d rows", n0 - nrow(out)))
  }
  dropped <- character()
  for (key in c("drop-empty-cols", "drop-constant-cols")) {
    o <- on(key)
    if (!is.null(o)) dropped <- c(dropped, o$columns)
  }
  if (length(dropped)) {
    out <- out[setdiff(names(out), dropped)]
    done <- c(done, paste0("columns dropped (empty / constant): ", join(dropped)))
  }
  snake_op <- on("rename-snake-case")
  if (!is.null(snake_op)) {
    out <- sc_snake_names(out)
    done <- c(done, sprintf("headers snake_cased: %d", length(snake_op$columns)))
  }
  o <- on("cap-outliers")
  if (!is.null(o)) {
    cols <- vapply(o$columns, .sc_rename, character(1), snake_op = snake_op)
    cols <- unname(cols[cols %in% names(out)])
    out <- sc_cap_outliers(out, cols)
    done <- c(done, sprintf("outliers capped: %s (%d values)", join(cols), o$cells))
  }
  o <- on("impute-missing")
  if (!is.null(o)) {
    cols <- vapply(o$columns, .sc_rename, character(1), snake_op = snake_op)
    cols <- unname(cols[cols %in% names(out)])
    out <- sc_impute(out, cols)
    done <- c(done, sprintf("imputed: %s (%d cells, was_missing_* indicators added)", join(cols), o$cells))
  }
  list(df = out, done = done)
}

.sc_plan_sig <- function(plan) paste(vapply(plan, function(o) paste(o$op, o$cells, paste(o$columns, collapse = "|"), sep = "\r"), character(1)), collapse = "\n")

#' Clean a data frame
#'
#' `sc_clean(df)` runs the safe ops once; `sc_clean(df, "all")` runs
#' everything until clean (at most 8 passes, or until the same plan comes
#' back twice). `ops` may also be a character vector of op names (aliases
#' accepted: "dedupe", "winsorize", "impute", "snake", "dates", "money" ...).
#' The returned table's notes list exactly what changed; nothing is printed.
#' @param df A data frame.
#' @param ops `NULL` / `"safe"` for the safe ops, `"all"` for everything, or
#'   a character vector of op names (see [SC_ALL_OPS]).
#' @param passes Maximum passes (default 1, or 8 for `"all"`).
#' @return A `scelo_table` of the cleaned data.
#' @examples
#' sc_clean(sc_sample("dirty"))
#' sc_notes(sc_clean(sc_sample("dirty"), "all"))
#' @export
sc_clean <- function(df, ops = NULL, passes = NULL) {
  .sc_tool("sc_clean", list(df = df, ops = ops, passes = passes), df, {
    if (is.null(ops) || (is.character(ops) && length(ops) == 1 && tolower(ops) %in% c("safe", "default", "recommended"))) {
      enabled <- SC_SAFE_OPS
      max_passes <- if (is.null(passes) || !passes) 1L else as.integer(passes)
    } else if (is.character(ops) && length(ops) == 1 && tolower(ops) %in% c("all", "everything", "*")) {
      enabled <- NULL
      max_passes <- if (is.null(passes) || !passes) .SC_AUTO_CLEAN_MAX_PASSES else as.integer(passes)
    } else {
      enabled <- unique(vapply(as.character(ops), .sc_norm_op, character(1)))
      max_passes <- if (is.null(passes) || !passes) 1L else as.integer(passes)
    }
    keep <- function(plan) if (is.null(enabled)) plan else Filter(function(o) o$op %in% enabled, plan)
    working <- if (inherits(df, "scelo_table")) sc_df(df) else as.data.frame(df, stringsAsFactors = FALSE)
    rows0 <- nrow(working); cols0 <- ncol(working)
    notes <- character()
    prev_sig <- NULL
    outcome <- "clean"
    for (p in seq_len(max_passes)) {
      plan <- keep(.sc_analyse(working))
      if (!length(plan)) {
        outcome <- "clean"
        break
      }
      sig <- .sc_plan_sig(plan)
      if (identical(sig, prev_sig)) {
        outcome <- "stalled"
        break
      }
      prev_sig <- sig
      step <- .sc_apply_plan(working, plan, vapply(plan, function(o) o$op, character(1)))
      working <- step$df
      notes <- c(notes, paste0(if (max_passes > 1) sprintf("pass %d · ", p) else "", step$done))
      outcome <- "exhausted"
    }
    remaining <- if (length(notes)) .sc_analyse(working) else list()
    if (outcome == "exhausted" && max_passes > 1) outcome <- if (length(keep(remaining))) "exhausted" else "clean"
    if (!length(notes)) {
      notes <- "Nothing to clean."
    } else {
      rem_enabled <- keep(remaining)
      rem_other <- if (is.null(enabled)) list() else Filter(function(o) !(o$op %in% enabled), remaining)
      shape <- sprintf("%s×%d → %s×%d", .sc_fmt_n(rows0), cols0, .sc_fmt_n(nrow(working)), ncol(working))
      if (outcome == "stalled") {
        notes <- c(notes, sprintf("%s · stalled: the same plan came back twice, so the rest needs a human.", shape))
      } else if (length(rem_enabled)) {
        notes <- c(notes, sprintf("%s · %d pass(es) spent; %d op(s) still apply, run again or inspect sc_suggest().", shape, max_passes, length(rem_enabled)))
      } else {
        notes <- c(notes, sprintf("%s · clean: a further pass finds nothing more to do%s", shape, if (length(rem_other)) {
          sprintf(" (%d unsafe op(s) available via sc_clean(df, \"all\"): %s).", length(rem_other), paste(vapply(rem_other, function(o) o$op, character(1)), collapse = ", "))
        } else "."))
      }
    }
    sc_table(working, title = sprintf("clean · %s rows", .sc_fmt_n(nrow(df))), notes = notes, stage = "soft")
  })
}
