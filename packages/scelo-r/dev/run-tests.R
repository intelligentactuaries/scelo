# Run one testthat file (or all) against the package sources without installing:
#   Rscript dev/run-tests.R                      # all tests
#   Rscript dev/run-tests.R test-life.R          # one file
for (f in sort(list.files("R", full.names = TRUE))) source(f)
library(testthat)
args <- commandArgs(trailingOnly = TRUE)
for (h in list.files("tests/testthat", pattern = "^helper", full.names = TRUE)) source(h)
files <- if (length(args)) file.path("tests/testthat", args) else list.files("tests/testthat", pattern = "^test-.*\\.R$", full.names = TRUE)
ok <- TRUE
for (f in files) {
  cat("==", f, "\n")
  res <- as.data.frame(test_file(f, reporter = "summary"))
  if (any(res$failed > 0) || any(res$error)) ok <- FALSE
}
quit(status = if (ok) 0 else 1)
