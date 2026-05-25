# Mack 1993 chain-ladder on the RAA triangle.
#
# RAA is the canonical small triangle from Mack's original paper and the
# fixture every chainladder library tests against. Pinned regression for
# this template: IBNR ≈ 52,135. If the R package version drifts and the
# IBNR moves by more than ±1%, treat it as a finding worth investigating
# (not as an excuse to bump the pinned number).

suppressPackageStartupMessages({
  library(ChainLadder)
  library(jsonlite)
})

here <- normalizePath(dirname(dirname(sys.frame(1)$ofile)))

# Bundled fixture; loaded by data() into the global env.
data("RAA")
triangle <- RAA

# Mack point estimate + standard error.
mack <- MackChainLadder(triangle, est.sigma = "Mack")
total_ibnr <- summary(mack)$Totals[2, 1]
total_se   <- summary(mack)$Totals[3, 1]

# Bootstrap distribution of total IBNR, 1000 paths.
boot <- BootChainLadder(triangle, R = 1000, process.distr = "od.pois")
boot_summary <- summary(boot)$Totals
ibnr_p50 <- quantile(boot$IBNR.Totals, 0.5)
ibnr_p95 <- quantile(boot$IBNR.Totals, 0.95)
ibnr_p99 <- quantile(boot$IBNR.Totals, 0.99)

cat(sprintf("Mack IBNR        : %12.2f\n", total_ibnr))
cat(sprintf("Mack SE          : %12.2f\n", total_se))
cat(sprintf("Bootstrap p50    : %12.2f\n", ibnr_p50))
cat(sprintf("Bootstrap p95    : %12.2f\n", ibnr_p95))
cat(sprintf("Bootstrap p99    : %12.2f\n", ibnr_p99))

out_path <- file.path(here, "data", "mack_results.json")
dir.create(dirname(out_path), showWarnings = FALSE, recursive = TRUE)
write_json(
  list(
    engine = "R-ChainLadder",
    triangle = "RAA",
    mack_ibnr = total_ibnr,
    mack_se = total_se,
    bootstrap_p50 = unname(ibnr_p50),
    bootstrap_p95 = unname(ibnr_p95),
    bootstrap_p99 = unname(ibnr_p99),
    chainladder_version = as.character(packageVersion("ChainLadder"))
  ),
  out_path,
  auto_unbox = TRUE,
  pretty = TRUE
)
cat(sprintf("Wrote %s\n", out_path))
