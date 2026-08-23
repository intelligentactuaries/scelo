# Charts: the few forms an actuarial report needs, drawn to one quiet spec
# in base graphics (no new dependency).
#
# Every sc_plot_* draws on the current device and returns its data
# invisibly. The look follows one spec for every chart: a white surface,
# hairline solid gridlines, thin marks, text in ink tokens (never in the
# series colour), selective direct labels, a legend whenever there is more
# than one series. The palette is Scelo's brand stepped to pass the colour
# checks (lightness band, chroma floor, colour-vision-deficiency separation,
# contrast) on white and on the IDE's cream; the first three series also pass
# every pairwise check, so small multiples stop at three hues.

#' The chart palette
#'
#' Surface, ink tokens, the validated categorical series order (first three
#' pass all-pairs), the one-hue sequential ramp and the diverging pair.
#' @return A named list.
#' @examples
#' sc_palette()$series
#' @export
sc_palette <- function() list(
  surface = "#FFFFFF", ink = "#181715", ink_2 = "#605A51", grid = "#E6E2D9", axis = "#CDC7B8", muted = "#B8B2A6",
  series = c("#1F8F5C", "#345DCB", "#C4631F", "#7649C7", "#B43939"),
  series_dark = c("#37996B", "#5F86DB", "#CC7238", "#9A72D6", "#D05656"),
  sequential = c("#7FC4A3", "#4FAC82", "#1F8F5C", "#156B43", "#0E4A2E"),
  diverging = c("#345DCB", "#EDEAE3", "#C4631F")
)

.sc_pal <- sc_palette()

.sc_fmt <- function(v, digits = 0) {
  vapply(v, function(x) {
    if (is.na(x) || !is.finite(x)) return("")
    if (abs(x) >= 1e6) return(sprintf("%.2fM", x / 1e6))
    if (abs(x) >= 1e4) return(paste0(formatC(x / 1e3, format = "f", digits = 0, big.mark = ","), "k"))
    if (abs(x) >= 100 || digits == 0) formatC(x, format = "f", digits = digits, big.mark = ",") else formatC(x, format = "f", digits = max(digits, 2))
  }, character(1))
}

.sc_viz_par <- function(mar = c(3.2, 4, 2.6, 1), ...) {
  op <- graphics::par(mar = mar, family = "sans", bg = .sc_pal$surface, col.axis = .sc_pal$ink_2, col.lab = .sc_pal$ink_2, col.main = .sc_pal$ink,
                      cex.axis = 0.8, cex.lab = 0.85, xaxs = "r", yaxs = "r", mgp = c(2, 0.5, 0), tcl = -0.25, ...)
  op
}

.sc_axis <- function(side, at = NULL, labels = TRUE, fmt = TRUE) {
  if (is.null(at)) at <- graphics::axTicks(side)
  lab <- if (isTRUE(labels)) (if (fmt) .sc_fmt(at) else at) else labels
  graphics::axis(side, at = at, labels = lab, col = .sc_pal$axis, col.ticks = .sc_pal$axis, lwd = 0.8, las = 1)
}

.sc_grid <- function(side = 2, at = NULL) {
  if (is.null(side)) return(invisible())
  if (is.null(at)) at <- graphics::axTicks(side)
  if (side == 2) graphics::abline(h = at, col = .sc_pal$grid, lwd = 0.8) else graphics::abline(v = at, col = .sc_pal$grid, lwd = 0.8)
}

.sc_title <- function(main, sub = NULL, line = 1.2) {
  if (!is.null(main)) graphics::mtext(main, side = 3, line = line, adj = 0, font = 2, cex = 0.95, col = .sc_pal$ink)
  if (!is.null(sub)) graphics::mtext(sub, side = 3, line = line - 0.9, adj = 0, cex = 0.72, col = .sc_pal$ink_2)
}

.sc_legend <- function(labels, cols, where = "topright") {
  graphics::legend(where, legend = labels, col = cols, lwd = 2, bty = "n", cex = 0.8, text.col = .sc_pal$ink_2, seg.len = 1.2)
}

# horizontal bars with values at the tips, bar height 0.5 of the slot
.sc_hbars <- function(values, labels, cols, xlim = NULL, fmt_fn = .sc_fmt, xlab = NULL, main = NULL, sub = NULL, vline = NULL, vline_label = NULL) {
  n <- length(values)
  if (is.null(xlim)) xlim <- c(0, max(values, na.rm = TRUE) * 1.18)
  lab_w <- max(graphics::strwidth(labels, units = "inches", cex = 0.8)) + 0.3
  op <- .sc_viz_par(mar = c(3.2, max(4, lab_w / 0.2), if (is.null(sub)) 2.6 else 3.2, 1))
  on.exit(graphics::par(op), add = TRUE)
  graphics::plot.new()
  graphics::plot.window(xlim = xlim, ylim = c(0.4, n + 0.6))
  .sc_grid(1)
  graphics::rect(0, seq_len(n) - 0.25, values, seq_len(n) + 0.25, col = cols, border = .sc_pal$surface, lwd = 1.5)
  graphics::text(values, seq_len(n), paste0("  ", fmt_fn(values)), adj = 0, cex = 0.78, col = .sc_pal$ink_2, xpd = TRUE)
  graphics::axis(2, at = seq_len(n), labels = labels, las = 1, tick = FALSE, lwd = 0, cex.axis = 0.82, col.axis = .sc_pal$ink_2)
  .sc_axis(1)
  if (!is.null(vline)) {
    graphics::abline(v = vline, col = .sc_pal$ink_2, lwd = 0.8)
    if (!is.null(vline_label)) graphics::text(vline, n + 0.55, vline_label, adj = c(0, 0), cex = 0.75, col = .sc_pal$ink_2, xpd = TRUE)
  }
  if (!is.null(xlab)) graphics::mtext(xlab, side = 1, line = 2, cex = 0.8, col = .sc_pal$ink_2)
  .sc_title(main, sub, line = if (is.null(sub)) 1 else 1.7)
  invisible(values)
}

#' One-series bar chart
#'
#' Magnitude by category: thin bars in one hue, values at the tips, optional
#' highlighted categories (the rest in the de-emphasis grey).
#' @param values A named numeric vector, or a data frame with `x` and `y`.
#' @param x,y Column names when `values` is a data frame.
#' @param title,subtitle Chart titles.
#' @param sort Sort by value.
#' @param highlight Categories to keep in the accent hue.
#' @param xlab Axis label.
#' @return The plotted values, invisibly.
#' @examples
#' sc_plot_bars(table(sc_sample("claims")$line), title = "Policies by line")
#' @export
sc_plot_bars <- function(values, x = NULL, y = NULL, title = NULL, subtitle = NULL, sort = TRUE, highlight = NULL, xlab = NULL) {
  if (is.data.frame(values)) { v <- as.numeric(values[[y]]); names(v) <- as.character(values[[x]]) } else { v <- as.numeric(values); names(v) <- names(values) }
  v <- v[!is.na(v)]
  if (sort) v <- sort(v)
  cols <- if (is.null(highlight)) rep(.sc_pal$series[1], length(v)) else ifelse(names(v) %in% as.character(highlight), .sc_pal$series[1], .sc_pal$muted)
  .sc_hbars(unname(v), names(v), cols, xlab = xlab, main = title, sub = subtitle)
}

#' Event rate by group
#'
#' Lapse rate by country, by MBTI ...: sorted bars in one hue with a 95 %
#' Poisson interval and n in the label; the overall rate as a reference line.
#' @param df A data frame.
#' @param by Group column.
#' @param event 0/1 (or count) column.
#' @param exposure Optional exposure column (rate per unit of exposure).
#' @param title Chart title.
#' @param ci Draw the interval.
#' @param min_n Drop groups with fewer rows.
#' @return The summary table, invisibly.
#' @examples
#' d <- sc_sample("claims"); d$settled <- d$settled == "yes"
#' sc_plot_rates(d, "line", "settled", title = "Settlement rate by line")
#' @export
sc_plot_rates <- function(df, by, event, exposure = NULL, title = NULL, ci = TRUE, min_n = 1) {
  e <- as.numeric(df[[event]]); e[is.na(e)] <- 0
  w <- if (is.null(exposure)) rep(1, nrow(df)) else { ww <- as.numeric(df[[exposure]]); ww[is.na(ww)] <- 0; ww }
  g <- as.character(df[[by]])
  agg <- data.frame(group = names(tapply(e, g, sum)), events = as.numeric(tapply(e, g, sum)), expo = as.numeric(tapply(w, g, sum)), n = as.numeric(table(g)[names(tapply(e, g, sum))]))
  agg <- agg[agg$n >= min_n, ]
  agg$rate <- agg$events / agg$expo
  agg$se <- sqrt(pmax(agg$events, 0.5)) / agg$expo
  agg <- agg[order(agg$rate), ]
  n <- nrow(agg)
  overall <- sum(e) / sum(w)
  labels <- sprintf("%s  (n=%s)", agg$group, formatC(agg$n, format = "d", big.mark = ","))
  xmax <- max(agg$rate + if (ci) 1.96 * agg$se else 0, overall) * 1.2
  lab_w <- max(graphics::strwidth(labels, units = "inches", cex = 0.8)) + 0.3
  op <- .sc_viz_par(mar = c(3.2, max(4, lab_w / 0.2), if (ci) 3.2 else 2.6, 1))
  on.exit(graphics::par(op), add = TRUE)
  graphics::plot.new()
  graphics::plot.window(xlim = c(0, xmax), ylim = c(0.4, n + 0.6))
  at <- graphics::axTicks(1)
  .sc_grid(1, at)
  graphics::rect(0, seq_len(n) - 0.25, agg$rate, seq_len(n) + 0.25, col = .sc_pal$series[1], border = .sc_pal$surface, lwd = 1.5)
  if (ci) graphics::arrows(agg$rate - 1.96 * agg$se, seq_len(n), agg$rate + 1.96 * agg$se, seq_len(n), angle = 90, code = 3, length = 0.02, col = .sc_pal$ink_2, lwd = 0.8)
  graphics::text(agg$rate + if (ci) 1.96 * agg$se else 0, seq_len(n), sprintf("  %.1f%%", 100 * agg$rate), adj = 0, cex = 0.78, col = .sc_pal$ink_2, xpd = TRUE)
  graphics::axis(2, at = seq_len(n), labels = labels, las = 1, tick = FALSE, lwd = 0, cex.axis = 0.82, col.axis = .sc_pal$ink_2)
  graphics::axis(1, at = at, labels = paste0(100 * at, "%"), col = .sc_pal$axis, col.ticks = .sc_pal$axis, lwd = 0.8)
  graphics::abline(v = overall, col = .sc_pal$ink_2, lwd = 0.8)
  graphics::text(overall, n + 0.55, sprintf(" all %.1f%%", 100 * overall), adj = c(0, 0), cex = 0.75, col = .sc_pal$ink_2, xpd = TRUE)
  .sc_title(title %||% sprintf("%s rate by %s", event, by), if (ci) "95 % Poisson interval" else NULL, line = if (ci) 1.7 else 1)
  invisible(agg)
}

#' Forest plot of a GLM's relativities
#'
#' One panel per factor: dots at exp(beta) with 95 % intervals on a log
#' axis, levels sorted by relativity, the base level hollow at 1, the three
#' largest labelled.
#' @param model A `scelo_glm` (log link).
#' @param title Chart title.
#' @return The relativity table, invisibly.
#' @examples
#' d <- sc_sample("claims"); d$n <- as.integer(d$paid > 20000)
#' sc_plot_relativities(sc_glm(d, "n ~ C(line) + C(sex)", "poisson"))
#' @export
sc_plot_relativities <- function(model, title = NULL) {
  coef <- model$coef
  keys <- as.character(coef$term)
  cats <- model$terms[vapply(model$terms, function(t) any(startsWith(keys, paste0(t, "["))), logical(1))]
  nums <- setdiff(model$terms, cats)
  panels <- lapply(cats, function(t) list(factor = t, keys = keys[startsWith(keys, paste0(t, "["))], cat = TRUE))
  if (length(nums)) panels <- c(panels, list(list(factor = "numeric (per unit)", keys = nums, cat = FALSE)))
  heights <- vapply(panels, function(p) length(p$keys) + 1.5, numeric(1))
  op <- graphics::par(no.readonly = TRUE)
  on.exit(graphics::par(op), add = TRUE)
  graphics::layout(matrix(seq_along(panels), ncol = 1), heights = heights)
  graphics::par(oma = c(3, 0, 3, 0), family = "sans", bg = .sc_pal$surface)
  est_all <- coef$estimate[match(unlist(lapply(panels, `[[`, "keys")), keys)]
  se_all <- coef$std_err[match(unlist(lapply(panels, `[[`, "keys")), keys)]
  xlim <- range(c(exp(est_all - 1.96 * se_all), exp(est_all + 1.96 * se_all), 1))
  ticks <- c(0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50)
  ticks <- ticks[ticks >= xlim[1] / 1.5 & ticks <= xlim[2] * 1.5]
  out <- list()
  for (i in seq_along(panels)) {
    p <- panels[[i]]
    est <- coef$estimate[match(p$keys, keys)]; se <- coef$std_err[match(p$keys, keys)]
    nm <- if (p$cat) substr(p$keys, nchar(p$factor) + 2, nchar(p$keys) - 1) else p$keys
    o <- order(est); est <- est[o]; se <- se[o]; nm <- nm[o]
    rel <- exp(est); lo <- exp(est - 1.96 * se); hi <- exp(est + 1.96 * se)
    y <- seq_along(nm) + if (p$cat) 1 else 0
    graphics::par(mar = c(if (i == length(panels)) 2.5 else 0.8, 8, 1.6, 1), mgp = c(2, 0.5, 0), tcl = -0.25, col.axis = .sc_pal$ink_2, cex.axis = 0.8, las = 1)
    graphics::plot.new()
    graphics::plot.window(xlim = log(xlim) + c(-0.15, 0.35), ylim = c(0.3, max(y) + 0.7))
    graphics::abline(v = log(ticks), col = .sc_pal$grid, lwd = 0.8)
    graphics::abline(v = 0, col = .sc_pal$ink_2, lwd = 0.8)
    graphics::segments(log(lo), y, log(hi), y, col = .sc_pal$series[1], lwd = 1.2)
    graphics::points(log(rel), y, pch = 21, bg = .sc_pal$series[1], col = .sc_pal$surface, cex = 1.1, lwd = 1.2)
    labels <- nm
    if (p$cat) {
      graphics::points(0, 1, pch = 21, bg = .sc_pal$surface, col = .sc_pal$series[1], cex = 1.1, lwd = 1.4)
      labels <- c(paste(model$base_levels[[p$factor]] %||% "", "(base)"), nm)
      y <- c(1, y)
    }
    graphics::axis(2, at = y, labels = labels, tick = FALSE, lwd = 0, cex.axis = 0.82, col.axis = .sc_pal$ink_2)
    top <- order(rel, decreasing = TRUE)[seq_len(min(3, length(rel)))]
    graphics::text(log(hi[top]), (if (p$cat) seq_along(nm) + 1 else seq_along(nm))[top], sprintf("  %.2f×", rel[top]), adj = 0, cex = 0.72, col = .sc_pal$ink_2, xpd = TRUE)
    graphics::mtext(p$factor, side = 3, line = 0.3, adj = 0, cex = 0.8, col = .sc_pal$ink)
    if (i == length(panels)) {
      graphics::axis(1, at = log(ticks), labels = paste0(ticks, "x"), col = .sc_pal$axis, col.ticks = .sc_pal$axis, lwd = 0.8)
      graphics::mtext("relativity (exp beta), 95 % interval", side = 1, line = 2, cex = 0.8, col = .sc_pal$ink_2)
    }
    out[[p$factor]] <- data.frame(level = nm, relativity = rel, lower95 = lo, upper95 = hi)
  }
  graphics::mtext(title %||% sprintf("Relativities · %s", model$formula), side = 3, line = 1.4, adj = 0, outer = TRUE, font = 2, cex = 0.95, col = .sc_pal$ink)
  graphics::mtext(sprintf("%s / %s · n = %s", model$family, model$link, formatC(model$n, format = "d", big.mark = ",")), side = 3, line = 0.4, adj = 0, outer = TRUE, cex = 0.72, col = .sc_pal$ink_2)
  invisible(out)
}

#' Three small multiples of a BasicTerm projection
#'
#' Annual cash flows (premiums, claims, expenses), the cumulative PV of net
#' cash flow, and the policies in force.
#' @param table A [sc_basicterm()] table.
#' @param title Chart title.
#' @return The annual table, invisibly.
#' @examples
#' sc_plot_projection(sc_basicterm(sc_sample("lifelib-mp")))
#' @export
sc_plot_projection <- function(table, title = NULL) {
  t <- sc_df(table)
  yr <- t$month %/% 12 + 1
  annual <- data.frame(year = sort(unique(yr)), premiums = as.numeric(tapply(t$premiums, yr, sum)), claims = as.numeric(tapply(t$claims, yr, sum)), expenses = as.numeric(tapply(t$expenses, yr, sum)))
  cum <- cumsum(t$pv_net_cf)
  op <- graphics::par(no.readonly = TRUE)
  on.exit(graphics::par(op), add = TRUE)
  graphics::layout(matrix(1:3, nrow = 1))
  graphics::par(oma = c(0, 0, 2.2, 0), family = "sans", bg = .sc_pal$surface)
  panel <- function(xlim, ylim, main, xlab = "projection year") {
    graphics::par(mar = c(3.2, 4.6, 2, 1), mgp = c(2, 0.5, 0), tcl = -0.25, col.axis = .sc_pal$ink_2, cex.axis = 0.8, las = 1)
    graphics::plot.new(); graphics::plot.window(xlim = xlim, ylim = ylim)
    .sc_grid(2); .sc_axis(2); .sc_axis(1, fmt = FALSE)
    graphics::mtext(xlab, side = 1, line = 2, cex = 0.75, col = .sc_pal$ink_2)
    graphics::mtext(main, side = 3, line = 0.4, adj = 0, font = 2, cex = 0.85, col = .sc_pal$ink)
  }
  panel(range(annual$year), c(0, max(annual[-1]) * 1.05), "Annual cash flows")
  for (i in 1:3) graphics::lines(annual$year, annual[[i + 1]], col = .sc_pal$series[i], lwd = 2)
  .sc_legend(c("premiums", "claims", "expenses"), .sc_pal$series[1:3])
  panel(c(0, max(t$month) / 12), range(c(0, cum)) * c(1, 1.05), "Cumulative PV of net cash flow")
  graphics::polygon(c(t$month / 12, rev(t$month / 12)), c(cum, rep(0, length(cum))), col = grDevices::adjustcolor(.sc_pal$series[1], 0.10), border = NA)
  graphics::lines(t$month / 12, cum, col = .sc_pal$series[1], lwd = 2)
  graphics::abline(h = 0, col = .sc_pal$ink_2, lwd = 0.8)
  be <- attr(table, "break_even_month")
  if (!is.null(be) && !is.na(be) && be > 1 && be < length(cum)) {
    graphics::points(be / 12, cum[be + 1], pch = 21, bg = .sc_pal$series[1], col = .sc_pal$surface, cex = 1.2, lwd = 1.4)
    graphics::text(be / 12, cum[be + 1], sprintf("  break-even month %d", be), adj = c(0, -0.3), cex = 0.75, col = .sc_pal$ink_2)
  }
  graphics::text(max(t$month) / 12, cum[length(cum)], paste0(" ", .sc_fmt(cum[length(cum)])), adj = 0, cex = 0.75, col = .sc_pal$ink_2, xpd = TRUE)
  if ("inforce_policies" %in% names(t)) {
    panel(c(0, max(t$month) / 12), c(0, max(t$inforce_policies) * 1.08), "Policies in force")
    graphics::lines(t$month / 12, t$inforce_policies, col = .sc_pal$series[1], lwd = 2)
    graphics::text(0, t$inforce_policies[1], paste0(" ", .sc_fmt(t$inforce_policies[1]), " at start"), adj = c(0, -0.4), cex = 0.75, col = .sc_pal$ink_2)
  }
  graphics::mtext(title %||% sc_title(table) %||% "BasicTerm projection", side = 3, line = 0.6, adj = 0, outer = TRUE, font = 2, cex = 0.95, col = .sc_pal$ink)
  invisible(annual)
}

#' The SCR build-up
#'
#' Sub-risk charges as bars in one hue, the undiversified sum and the
#' diversified SCR in ink, the diversification benefit in the subtitle.
#' @param table An [sc_scr_life()] or [sc_aggregate_scr()] table.
#' @param title Chart title.
#' @return The plotted values, invisibly.
#' @examples
#' sc_plot_scr(sc_scr_life(sc_sample("lifelib-mp")))
#' @export
sc_plot_scr <- function(table, title = NULL) {
  t <- sc_df(table)
  mods <- t[!t$module %in% c("sum", "SCR", "diversification") & t$charge > 0, ]
  mods <- mods[order(mods$charge), ]
  total <- if ("sum" %in% t$module) t$charge[t$module == "sum"] else sum(mods$charge)
  scr <- if ("SCR" %in% t$module) t$charge[t$module == "SCR"] else NA_real_
  vals <- c(scr, total, mods$charge)
  labels <- c("SCR (diversified)", "sum of charges", mods$module)
  cols <- c(.sc_pal$ink_2, .sc_pal$muted, rep(.sc_pal$series[1], nrow(mods)))
  div <- total - scr
  .sc_hbars(vals, labels, cols, main = title %||% sc_title(table) %||% "Solvency II life SCR",
            sub = sprintf("diversification %s (%.0f%% of the charges)", .sc_fmt(div), 100 * div / total), vline = scr)
}

#' IFRS 17 CSM roll-forward
#'
#' The closing balance by year (line, from CSM0) beside the yearly release
#' (columns), on the same x-axis.
#' @param table An [sc_csm()] table.
#' @param title Chart title.
#' @return The table, invisibly.
#' @examples
#' sc_plot_csm(sc_csm(sc_sample("lifelib-mp"), sc_basicterm_assumptions(premium_mult = 3), ra = 0.05))
#' @export
sc_plot_csm <- function(table, title = NULL) {
  t <- sc_df(table)
  op <- graphics::par(no.readonly = TRUE)
  on.exit(graphics::par(op), add = TRUE)
  graphics::layout(matrix(1:2, nrow = 1))
  graphics::par(oma = c(0, 0, 2.2, 0), family = "sans", bg = .sc_pal$surface, mar = c(3.2, 4.6, 2, 1), mgp = c(2, 0.5, 0), tcl = -0.25, col.axis = .sc_pal$ink_2, cex.axis = 0.8, las = 1)
  yrs <- c(t$year[1] - 1, t$year); bal <- c(t$csm_open[1], t$csm_close)
  graphics::plot.new(); graphics::plot.window(xlim = range(yrs), ylim = c(0, max(bal) * 1.08))
  .sc_grid(2); .sc_axis(2); .sc_axis(1, fmt = FALSE)
  graphics::polygon(c(yrs, rev(yrs)), c(bal, rep(0, length(bal))), col = grDevices::adjustcolor(.sc_pal$series[1], 0.10), border = NA)
  graphics::lines(yrs, bal, col = .sc_pal$series[1], lwd = 2)
  graphics::points(yrs[1], bal[1], pch = 21, bg = .sc_pal$series[1], col = .sc_pal$surface, cex = 1.2, lwd = 1.4)
  graphics::text(yrs[1], bal[1], paste0("  CSM at issue ", .sc_fmt(bal[1])), adj = 0, cex = 0.75, col = .sc_pal$ink_2)
  graphics::mtext("year", side = 1, line = 2, cex = 0.75, col = .sc_pal$ink_2)
  graphics::mtext("CSM balance (closing)", side = 3, line = 0.4, adj = 0, font = 2, cex = 0.85, col = .sc_pal$ink)
  graphics::plot.new(); graphics::plot.window(xlim = range(yrs), ylim = c(0, max(t$release) * 1.08))
  .sc_grid(2); .sc_axis(2); .sc_axis(1, fmt = FALSE)
  graphics::rect(t$year - 0.3, 0, t$year + 0.3, t$release, col = .sc_pal$series[1], border = .sc_pal$surface, lwd = 1.2)
  graphics::mtext("year", side = 1, line = 2, cex = 0.75, col = .sc_pal$ink_2)
  graphics::mtext("Release to P&L (coverage units)", side = 3, line = 0.4, adj = 0, font = 2, cex = 0.85, col = .sc_pal$ink)
  graphics::mtext(title %||% sc_title(table) %||% "IFRS 17 CSM", side = 3, line = 0.6, adj = 0, outer = TRUE, font = 2, cex = 0.95, col = .sc_pal$ink)
  invisible(t)
}

#' Lines over x
#'
#' Up to five series as 2 px lines in the fixed categorical order, with a
#' legend; a single series is end-labelled instead.
#' @param df A data frame.
#' @param x X column.
#' @param ys Series columns (at most five).
#' @param title,subtitle Chart titles.
#' @return `df`, invisibly.
#' @examples
#' sc_plot_lines(sc_df(sc_discount_curve(0.04, max_tenor = 20)), "tenor", c("discount factor", "1y forward"))
#' @export
sc_plot_lines <- function(df, x, ys, title = NULL, subtitle = NULL) {
  if (length(ys) > 5) stop("sc_plot_lines takes at most five series; fold the rest or use small multiples", call. = FALSE)
  op <- .sc_viz_par(mar = c(3.2, 4.6, if (is.null(subtitle)) 2.6 else 3.2, 1))
  on.exit(graphics::par(op), add = TRUE)
  yy <- unlist(df[ys])
  graphics::plot.new(); graphics::plot.window(xlim = range(df[[x]]), ylim = range(yy, na.rm = TRUE))
  .sc_grid(2); .sc_axis(2); .sc_axis(1, fmt = FALSE)
  for (i in seq_along(ys)) graphics::lines(df[[x]], df[[ys[i]]], col = .sc_pal$series[i], lwd = 2)
  if (length(ys) > 1) .sc_legend(ys, .sc_pal$series[seq_along(ys)]) else graphics::text(max(df[[x]]), df[[ys]][nrow(df)], paste0(" ", ys), adj = 0, cex = 0.75, col = .sc_pal$ink_2, xpd = TRUE)
  graphics::mtext(x, side = 1, line = 2, cex = 0.8, col = .sc_pal$ink_2)
  .sc_title(title, subtitle, line = if (is.null(subtitle)) 1 else 1.7)
  invisible(df)
}

#' Development curves of a triangle
#'
#' One line per origin in the one-hue ordinal ramp (oldest light, latest
#' dark), first and last origin labelled.
#' @param tri A cumulative triangle (see [sc_triangle()]).
#' @param title Chart title.
#' @return The triangle, invisibly.
#' @examples
#' sc_plot_triangle(sc_triangle(sc_sample("claims")))
#' @export
sc_plot_triangle <- function(tri, title = NULL) {
  m <- as.matrix(sc_df(tri)); mode(m) <- "numeric"
  n <- nrow(m); dev <- as.numeric(colnames(m))
  ramp <- .sc_pal$sequential
  op <- .sc_viz_par(mar = c(3.2, 4.6, 3.2, 2))
  on.exit(graphics::par(op), add = TRUE)
  graphics::plot.new(); graphics::plot.window(xlim = range(dev) + c(0, diff(range(dev)) * 0.08), ylim = c(0, max(m, na.rm = TRUE) * 1.05))
  .sc_grid(2); .sc_axis(2); .sc_axis(1, fmt = FALSE)
  for (i in seq_len(n)) {
    ok <- is.finite(m[i, ])
    col <- ramp[min(length(ramp), floor((i - 1) * length(ramp) / n) + 1)]
    graphics::lines(dev[ok], m[i, ok], col = col, lwd = 1.6)
    if (i %in% c(1, n)) graphics::text(max(dev[ok]), m[i, ok][sum(ok)], paste0(" ", rownames(m)[i]), adj = 0, cex = 0.75, col = .sc_pal$ink_2, xpd = TRUE)
  }
  graphics::mtext("development period", side = 1, line = 2, cex = 0.8, col = .sc_pal$ink_2)
  .sc_title(title %||% sc_title(tri) %||% "Development", sprintf("%d origins, oldest light to latest dark", n), line = 1.7)
  invisible(tri)
}
