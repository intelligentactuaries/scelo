# Pricing & fairness

GLMs with a small formula language and honest reference levels,
frequency–severity summaries, lift and Gini — and then the questions a
pricing actuary is increasingly asked to answer: group fairness metrics
and a protected-direction audit, ported from the IDE's Hard Data layer.

## GLMs

=== "Python"

    ```python
    m = sc.glm(df, "claims ~ C(region) + age", "poisson", offset="exposure")
    m.relativities()               # exp(β) per level; base level = 1
    m.predict(new_business)        # encoded exactly like the training data
    m.coef                         # term, estimate, std error, z, p — a Table
    sc.rate_table(m)               # the relativities as a wide rating table
    ```

=== "R"

    ```r
    m <- sc_glm(df, "claims ~ C(region) + age", "poisson", offset = "exposure")
    sc_relativities(m)
    sc_predict(m, new_business)    # or predict(m, new_business)
    m$coef
    sc_rate_table(m)
    ```

```text
  factor          level  relativity  estimate
0   line  marine (base)    1.000000  0.000000
1   line    engineering    0.818310 -0.200514
2   line      liability    0.854226 -0.157560
3   line          motor    0.822674 -0.195195
5    age       per unit    0.994120 -0.005897
— Relativities · paid ~ C(line) + age
  basis: base rate exp(intercept) = 35328.4
  · Multiply the base rate by one relativity per factor; the base level of each
    factor is its most frequent level.
```

The details that matter in practice:

- **Formulas** are the useful subset: `y ~ a + C(b) + c`. `C()` marks a
  categorical; text, factor and boolean columns count as categorical
  without it.
- **Base levels.** Scelo's default base is each factor's **most frequent
  level** — the natural base for a rating table. `base="first"` gives the
  alphabetical convention (R / statsmodels), and `base={"region": "GP"}`
  pins it exactly. Fitted values are identical either way; only the
  parameterisation moves.
- **Families**: poisson, gamma, gaussian, binomial, tweedie
  (`power=`, needs `statmod` in R), inverse-Gaussian — default log links
  except gaussian (identity) and binomial (logit).
- **Engines.** Python fits with statsmodels when installed (the IDE's
  canonical engine) and otherwise with a numpy IRLS **tested to agree
  with statsmodels to 1e-5**; R fits with `stats::glm.fit`. The engine
  used is printed in the model header.
- The offset enters as `log(offset)`; rows that cannot enter the fit
  (missing terms, non-positive offset or gamma response) are dropped and
  counted.
- `relativities` insists on a log link — on any other link, exp(β) is
  not a relativity, and it says so instead of printing one.

## Portfolio summaries

=== "Python"

    ```python
    sc.freq_sev(claims, "line")            # exposure, claims, frequency, severity, pure premium
    sc.loss_ratio(df, "line")              # loss, premium, loss ratio + total
    sc.burning_cost(df, trend=0.05, to_year=2026)
    sc.lift(actual, m.fitted, bins=10)     # equal-exposure deciles, A/E per band, Gini
    sc.gini(actual, m.fitted)
    ```

=== "R"

    ```r
    sc_freq_sev(claims, "line")
    sc_loss_ratio(df, "line")
    sc_burning_cost(df, trend = 0.05, to_year = 2026)
    sc_lift(actual, m$fitted, bins = 10)
    sc_gini(actual, m$fitted)
    ```

`price("claims.csv", "n ~ C(region) + age", severity="amount")` /
`sc_price(...)` is the one-liner: a frequency GLM, a Gamma severity GLM
on the positive amounts, and one table of frequency × severity = pure
premium relativities, with both fitted models in the attributes.

## Fairness

=== "Python"

    ```python
    sc.fairness(df, "y", "score", "group")          # per-group metrics + the gaps
    sc.disparate_impact(df, "score", "group")       # selection rate vs the best-off group
    sc.fairness_audit(df, "score", protected="race", legitimate=["age", "vehicle_value"])
    ```

=== "R"

    ```r
    sc_fairness(df, "y", "score", "group")
    sc_disparate_impact(df, "score", "group")
    sc_fairness_audit(df, "score", protected = "race", legitimate = c("age", "vehicle_value"))
    ```

- `fairness` reports, per group: base rate, selection rate, TPR, FPR,
  precision, mean score and disparate impact — and its notes state the
  demographic-parity gap, whether the four-fifths rule passes, and the
  equal-opportunity and equalised-odds gaps. Scores are thresholded at
  `threshold=0.5`; hard 0/1 decisions are recognised and used as they
  are.
- `fairness_audit` asks the sharper question: **how much of the
  prediction's variation beyond the legitimate factors aligns with the
  protected attribute?** It residualises the score on the legitimate
  factors, measures the protected alignment and disparity of that
  residual, then shows the same numbers after orthogonalising — with the
  mitigated score in the attributes, ready to compare.

## Function list

`design_matrix` `glm` `relativities` `predict` `rate_table` `freq_sev`
`loss_ratio` `burning_cost` `lift` `gini` `price` · `fairness`
`disparate_impact` (`parity`) `fairness_audit` — each with the `sc_`
twin in R.
