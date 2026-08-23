# Workspace: the Hard Data layer's "global workspace" diagnostics.
#
# A port of the IDE's numpy bottleneck bridge (apps/web/.../bridges/
# bottleneckPython.ts) and the active-subspace pieces around it: which few
# directions in the drivers the report heads actually turn on, how sparse
# and non-negative the broadcast from codes to heads is, and whether the
# codes are causally aligned with the marginal slopes. The linear special
# case with one code is exactly Lee-Carter; see Denewade (2026), "A Global
# Workspace for Actuarial Models". The eigen-decompositions are base R's
# eigen(); the projected-gradient fit of the broadcast runs on all heads at
# once (one matrix update per step instead of one per head), which gives
# the numpy bridge's numbers in a fraction of its time.

#' Participation ratio
#'
#' (sum of lambda)^2 / sum of lambda^2: the effective number of directions.
#' @param eigenvalues A numeric vector (non-positive entries are ignored).
#' @return A number (0 for no positive eigenvalue).
#' @examples
#' sc_participation_ratio(c(3, 1, 0.1))
#' @export
sc_participation_ratio <- function(eigenvalues) {
  w <- as.numeric(eigenvalues)
  w <- w[!is.na(w) & w > 0]
  if (!length(w)) return(0)
  sum(w)^2 / sum(w^2)
}

# Name a direction by its largest loadings: "mortality trend up, cohort effect down".
.sc_name_code <- function(loadings, cols) {
  ord <- order(-abs(loadings))
  top <- abs(loadings[ord[1]])
  parts <- character()
  for (j in utils::head(ord, 3)) {
    if (top > 0 && abs(loadings[j]) >= 0.35 * top) {
      parts <- c(parts, paste(gsub("[_-]", " ", as.character(cols[j])), if (loadings[j] > 0) "up" else "down"))
    }
  }
  if (length(parts)) paste(parts, collapse = ", ") else "mixed"
}

# Numeric matrix of the named columns, complete rows only, thinned to max_rows
# by a regular stride (the IDE's cap).
.sc_numeric_matrix <- function(df, cols, max_rows) {
  X <- as.data.frame(lapply(df[cols], function(v) suppressWarnings(as.numeric(if (is.factor(v)) as.character(v) else v))))
  X <- X[stats::complete.cases(X), , drop = FALSE]
  if (nrow(X) > max_rows) {
    step <- max(1L, nrow(X) %/% max_rows)
    X <- X[seq(1L, nrow(X), by = step), , drop = FALSE]
  }
  m <- as.matrix(X)
  dimnames(m) <- NULL
  m
}

.sc_standardise <- function(X) {
  mu <- colMeans(X)
  sd <- apply(X, 2, stats::sd)
  sd[sd < 1e-9] <- 1
  sweep(sweep(X, 2, mu, "-"), 2, sd, "/")
}

#' Workspace bottleneck
#'
#' `r` codes (top eigen-directions of the standardised drivers) broadcast
#' non-negatively to every column. Returns the heads x codes broadcast
#' matrix with the code names, and as attributes the participation ratio,
#' reconstruction R^2, causal alignment and sparsity (the IDE's four
#' workspace metrics).
#' @param df A data frame.
#' @param columns Driver columns (all numeric columns by default).
#' @param r Number of codes.
#' @param l1 L1 penalty of the projected-gradient fit.
#' @param max_rows Thin the frame to at most this many rows.
#' @return A `scelo_table` with a `head` column and one `code k: name` column
#'   per code; attributes `participation_ratio`, `reconstruction_r2`,
#'   `causal_alignment`, `sparsity`, `code_loadings` (a data frame of the
#'   oriented eigenvectors), `eigenvalues`.
#' @examples
#' ws <- sc_sample("workspace-demo")
#' b <- sc_bottleneck(ws[, 1:6], r = 2)
#' attr(b, "causal_alignment")
#' @export
sc_bottleneck <- function(df, columns = NULL, r = 3, l1 = 1e-3, max_rows = 20000) {
  .sc_tool("sc_bottleneck", list(df = df, columns = columns, r = r, l1 = l1), df, {
    cols <- if (!is.null(columns)) as.character(columns) else .sc_numeric_columns(df)
    X <- .sc_numeric_matrix(df, cols, max_rows)
    if (nrow(X) < 10 || ncol(X) < 3) stop("need at least 10 complete rows and 3 numeric columns", call. = FALSE)
    p <- ncol(X)
    r <- max(1L, min(as.integer(r), p - 1L))
    Z <- .sc_standardise(X)
    C <- stats::cov(Z)
    e <- eigen(C, symmetric = TRUE)
    w <- e$values
    Vr <- e$vectors[, seq_len(r), drop = FALSE]
    codes <- Z %*% Vr
    rowsum <- rowSums(Z)
    for (k in seq_len(r)) {
      if (stats::sd(rowsum) > 0 && stats::sd(codes[, k]) > 0 && stats::cor(codes[, k], rowsum) < 0) {
        Vr[, k] <- -Vr[, k]
        codes[, k] <- -codes[, k]
      }
    }
    G <- crossprod(codes)
    lr <- 1 / (sum(diag(G)) + 1e-9)
    Gt <- crossprod(Z, codes) # p x r: codes' z_c for every head at once
    B <- matrix(0, p, r)
    for (i in seq_len(300)) B <- pmax(B - lr * (B %*% G - Gt + l1), 0)
    recon <- codes %*% t(B)
    ss_res <- colSums((Z - recon)^2)
    ss_tot <- colSums(Z^2)
    r2 <- mean(pmin(1, pmax(0, 1 - ss_res / ifelse(ss_tot > 0, ss_tot, 1))))
    aligns <- numeric()
    for (k in seq_len(r)) {
      zk <- codes[, k]
      vk <- mean((zk - mean(zk))^2)
      slopes <- if (vk > 0) as.numeric(stats::cov(Z, zk)) / vk else rep(0, p)
      if (stats::sd(B[, k]) > 0 && stats::sd(slopes) > 0) aligns <- c(aligns, stats::cor(B[, k], slopes)^2)
    }
    align <- if (length(aligns)) mean(aligns) else 0
    pr <- sc_participation_ratio(w[seq_len(r)])
    sparsity <- if (length(B) && max(abs(B)) > 0) mean(abs(B) < 0.02 * max(abs(B))) else 1
    names <- vapply(seq_len(r), function(k) .sc_name_code(Vr[, k], cols), character(1))
    out <- data.frame(head = cols, stringsAsFactors = FALSE)
    for (k in seq_len(r)) out[[sprintf("code %d: %s", k, names[k])]] <- B[, k]
    t <- sc_table(out, title = sprintf("Workspace bottleneck · %d codes · %s rows", r, format(nrow(X), big.mark = ",")),
                  basis = sprintf("PR %.2f · reconstruction R² %.2f · causal alignment %.2f · sparsity %.2f", pr, r2, align, sparsity), stage = "hard", notes = c(
      "Codes are the leading eigenvectors of the standardised driver covariance, oriented positively; the broadcast B ≥ 0 is fitted by projected gradient with an L1 penalty (300 steps).",
      "Participation ratio = effective number of codes; causal alignment = how well each code's broadcast matches the marginal slopes of the heads on that code."
    ))
    loadings <- as.data.frame(Vr)
    names(loadings) <- names
    loadings <- cbind(data.frame(head = cols, stringsAsFactors = FALSE), loadings)
    attr(t, "participation_ratio") <- pr
    attr(t, "reconstruction_r2") <- r2
    attr(t, "causal_alignment") <- align
    attr(t, "sparsity") <- sparsity
    attr(t, "code_loadings") <- loadings
    attr(t, "eigenvalues") <- w
    t
  })
}

#' Active subspace of a readout
#'
#' Eigen-directions of the gradient covariance C = E(grad f grad f') of a
#' linear-quadratic surrogate of the readout. Reports each direction's
#' sensitivity share, input-variance share and named loadings: a direction
#' can carry most of the decision and almost none of the variance (the
#' workspace signature).
#' @param df A data frame.
#' @param readout The output column.
#' @param drivers Driver columns (every other numeric column by default).
#' @param max_rows Thin the frame to at most this many rows.
#' @return A `scelo_table` with `direction`, `eigenvalue`, `sensitivity_share`,
#'   `variance_share`, `name`, `loadings` (up to six directions); attributes
#'   `rank`, `participation_ratio`, `surrogate_r2`, `sensitivity_spectrum`,
#'   `variance_spectrum`, `directions` (the eigenvector matrix).
#' @examples
#' ws <- sc_sample("workspace-demo")
#' a <- sc_active_subspace(ws, "annuity_60", drivers = c("mortality_trend", "cohort_effect", "smoking_index", "crude_rate"))
#' attr(a, "rank")
#' @export
sc_active_subspace <- function(df, readout, drivers = NULL, max_rows = 20000) {
  .sc_tool("sc_active_subspace", list(df = df, readout = readout, drivers = drivers), df, {
    if (!readout %in% names(df)) stop(sprintf('column "%s" is not in the data (have: %s)', readout, paste(names(df), collapse = ", ")), call. = FALSE)
    cols <- if (!is.null(drivers)) as.character(drivers) else setdiff(.sc_numeric_columns(df), readout)
    M <- .sc_numeric_matrix(df, c(cols, readout), max_rows)
    X <- M[, seq_along(cols), drop = FALSE]
    y <- M[, length(cols) + 1L]
    Z <- .sc_standardise(X)
    n <- nrow(Z)
    p <- ncol(Z)
    # quadratic surrogate: y ~ b0 + sum b_i z_i + sum_{i<=j} c_ij z_i z_j
    pairs <- which(upper.tri(diag(p), diag = TRUE), arr.ind = TRUE)
    pairs <- pairs[order(pairs[, 1], pairs[, 2]), , drop = FALSE]
    Fm <- cbind(1, Z, Z[, pairs[, 1], drop = FALSE] * Z[, pairs[, 2], drop = FALSE])
    fit <- stats::lm.fit(Fm, y)
    beta <- fit$coefficients
    beta[is.na(beta)] <- 0
    yhat <- as.numeric(Fm %*% beta)
    r2 <- if (stats::var(y) > 0) 1 - sum((y - yhat)^2) / sum((y - mean(y))^2) else 0
    lin <- beta[1 + seq_len(p)]
    Q <- matrix(0, p, p) # symmetric: 2 c_ii on the diagonal, c_ij off it
    for (k in seq_len(nrow(pairs))) {
      i <- pairs[k, 1]; j <- pairs[k, 2]
      if (i == j) Q[i, i] <- 2 * beta[1 + p + k] else { Q[i, j] <- beta[1 + p + k]; Q[j, i] <- beta[1 + p + k] }
    }
    grads <- matrix(lin, n, p, byrow = TRUE) + Z %*% Q
    Cf <- crossprod(grads) / n
    e <- eigen(Cf, symmetric = TRUE)
    w <- e$values
    V <- e$vectors
    CZ <- stats::cov(Z)
    var_eig <- sort(eigen(CZ, symmetric = TRUE, only.values = TRUE)$values, decreasing = TRUE)
    tau <- if (w[1] > 0) 1e-3 * w[1] else 0
    rank <- sum(w > tau)
    kk <- seq_len(min(6L, p))
    rows <- lapply(kk, function(k) {
      v <- V[, k]
      vshare <- if (sum(var_eig) > 0) as.numeric(t(v) %*% CZ %*% v) / sum(var_eig) else 0
      keep <- abs(v) >= 0.2
      data.frame(direction = k, eigenvalue = w[k], sensitivity_share = if (sum(w) > 0) w[k] / sum(w) else 0, variance_share = vshare,
                 name = .sc_name_code(v, cols), loadings = paste(sprintf("%s:%+.2f", cols[keep], v[keep]), collapse = ", "), stringsAsFactors = FALSE)
    })
    out <- do.call(rbind, rows)
    pr <- sc_participation_ratio(w)
    t <- sc_table(out, title = sprintf("Active subspace · %s", readout), basis = sprintf("%d drivers · surrogate R² %.2f · rank %d · PR %.2f", p, r2, rank, pr), stage = "hard", notes = c(
      "Directions are eigenvectors of C = E[∇f∇fᵀ] for a quadratic surrogate of the readout; sensitivity share is the share of C's trace, variance share the share of input variance the direction occupies.",
      sprintf("Workspace variance fraction %.3f over the %d active directions.", sum(utils::head(out$variance_share, rank)), rank)
    ))
    attr(t, "rank") <- rank
    attr(t, "participation_ratio") <- pr
    attr(t, "surrogate_r2") <- r2
    attr(t, "sensitivity_spectrum") <- w
    attr(t, "variance_spectrum") <- var_eig
    attr(t, "directions") <- V
    t
  })
}
