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

# The workspace root, two levels up from this script however it is run:
# Rscript (make, the editor's Run) passes it as --file=; source() sets ofile.
script <- sub("^--file=", "", grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE))
if (length(script) == 0 && sys.nframe() > 0) script <- sys.frame(1)$ofile
if (length(script) == 0) script <- "r/mack_raa.R"
here <- normalizePath(dirname(dirname(script[1])))

# Bundled fixture; loaded by data() into the global env.
data("RAA")
triangle <- RAA

# Mack point estimate + standard error, read by row name: the Totals rows
# are Latest, Dev, Ultimate, IBNR, Mack S.E. and CV(IBNR).
mack <- MackChainLadder(triangle, est.sigma = "Mack")
totals <- summary(mack)$Totals
total_ibnr <- totals["IBNR:", 1]
total_se   <- totals["Mack S.E.:", 1]

# Bootstrap distribution of total IBNR, 1000 paths. Seeded, so a re-run
# prints the same percentiles; change the seed to see the bootstrap's spread.
set.seed(42)
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
