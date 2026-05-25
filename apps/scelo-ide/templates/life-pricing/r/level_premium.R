# Deterministic level-premium projection for a term-life policy.
#
# Reads qx from data/qx_male_2019.csv (written by python/mortality.py),
# computes APV(annuity-due_n) and APV(insurance_n) at a flat interest
# rate, and prints the breakeven level premium P that satisfies:
#
#   P * APV(annuity_due_n) = SA * APV(insurance_n)
#
# No insurance-package dependency; everything is one loop so a reader
# can see the recursion.

here <- normalizePath(dirname(dirname(sys.frame(1)$ofile)))
qx_path <- file.path(here, "data", "qx_male_2019.csv")
if (!file.exists(qx_path)) {
  stop("missing ", qx_path, ": run python/mortality.py first.")
}

qx_df <- read.csv(qx_path)
qx <- setNames(qx_df$qx, qx_df$age)

age <- 35L      # issue age
term <- 20L     # term in years
i <- 0.03       # flat interest assumption
SA <- 100000    # sum assured

v <- 1 / (1 + i)

# Survival probabilities tpx for t = 0..term.
tpx <- numeric(term + 1L)
tpx[1] <- 1
for (t in seq_len(term)) {
  q <- qx[as.character(age + t - 1L)]
  if (is.na(q)) stop("qx missing for age ", age + t - 1L)
  tpx[t + 1L] <- tpx[t] * (1 - q)
}

# APV of an annuity-due over `term` years (pays 1 at start of each year alive).
a_due <- sum(v^(0:(term - 1L)) * tpx[1:term])

# APV of a term insurance paying SA at end of year of death.
A_term <- sum(v^(1:term) * (tpx[1:term] - tpx[2:(term + 1L)]))

P <- SA * A_term / a_due

cat(sprintf("age %d, term %d, i %.2f%%\n", age, term, i * 100))
cat(sprintf("APV annuity_due_%d = %.4f\n", term, a_due))
cat(sprintf("APV insurance_%d   = %.6f\n", term, A_term))
cat(sprintf("level premium P    = %.2f per unit SA\n", P / SA))
cat(sprintf("level premium P    = %.2f at SA=%s\n", P, format(SA, big.mark = ",")))
