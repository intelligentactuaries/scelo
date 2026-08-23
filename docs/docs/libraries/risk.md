# Risk

Tail measures, aggregate-loss models, severity fitting, credibility, and
Solvency II aggregation — numpy / base R throughout, with scipy adding
polish when it is installed and never being required.

## Tail measures

=== "Python"

    ```python
    sc.var(losses, 0.995)        # type-7 quantile of the sample
    sc.tvar(losses, 0.995)       # mean beyond it (sc.es is the same function)
    ```

=== "R"

    ```r
    sc_var(losses, 0.995)
    sc_tvar(losses, 0.995)       # sc_es() is the same function
    ```

## Aggregate losses

=== "Python"

    ```python
    sc.aggregate_loss("poisson", "lognormal", lam=5, mu=8, sigma=1)
    sc.aggregate_loss("negbin", "gamma", r=4, beta=1.2, alpha=2, theta=500, method="fft")
    sc.aggregate_loss("poisson", losses_sample, lam=3, method="mc", n_sims=100_000)
    sc.simulate_losses("poisson", "lognormal", lam=5, mu=8, sigma=1, n_sims=10_000)
    sc.panjer("poisson", severity_pmf, lam=5)     # the raw recursion, if you want the pmf
    ```

=== "R"

    ```r
    sc_aggregate_loss("poisson", "lognormal", lam = 5, mu = 8, sigma = 1)
    sc_aggregate_loss("negbin", "gamma", r = 4, beta = 1.2, alpha = 2, theta = 500, method = "fft")
    sc_aggregate_loss("poisson", losses, lam = 3, method = "mc", n_sims = 100000)
    sc_simulate_losses("poisson", "lognormal", lam = 5, mu = 8, sigma = 1)
    sc_panjer("poisson", severity_pmf, lam = 5)
    ```

```text
       p           VaR           TVaR
0  0.500  20638.189466   37468.522951
3  0.950  58194.894715   75982.678420
5  0.995  99351.284174  123539.901999
— Aggregate loss · poisson(lam=5) × lognormal
  basis: panjer · lattice h = 119.989 × 4096
  · Mean 24,573.18 · sd 18,108.75 · CV 0.737.
```

Frequencies: `poisson(lam)`, `negbin(r, beta)`, `binomial(m, q)`.
Severities: `lognormal`, `gamma`, `pareto` (Lomax), `exponential`,
`weibull` — Loss-Models parameterisation — or an empirical sample.
Methods: `panjer` (exact on a lattice), `fft`, `mc` (seeded). If the
lattice is too short to reach the 99.9th percentile, the basis line says
`WARNING lattice too short` rather than quietly truncating the tail.

## Fitting severities

=== "Python"

    ```python
    sc.fit(losses)   # lognormal · gamma · pareto · weibull · exponential, ranked by AIC
    ```

=== "R"

    ```r
    sc_fit(losses)
    ```

Closed-form where a closed form exists, maximum likelihood where not
(scipy when available, a numpy Newton fallback when not), with
Kolmogorov–Smirnov distances alongside the AICs. A family that fails to
fit becomes a `failed: …` row instead of sinking the whole call.

## Credibility

=== "Python"

    ```python
    sc.credibility(df, "group", "loss_ratio")            # Bühlmann
    sc.credibility(df, "group", "loss_ratio", weight="exposure")   # Bühlmann–Straub
    sc.limited_fluctuation(n=800, p=0.9, k=0.05)          # classical partial credibility
    sc.full_credibility(p=0.9, k=0.05)                    # 1082.2 claims
    ```

=== "R"

    ```r
    sc_credibility(df, "group", "loss_ratio")
    sc_credibility(df, "group", "loss_ratio", weight = "exposure")
    sc_limited_fluctuation(n = 800, p = 0.9, k = 0.05)
    sc_full_credibility(p = 0.9, k = 0.05)
    ```

The Bühlmann table reports each group's `Z` and credibility premium, with
μ, EPV, VHM and K in the basis line. When the variance of hypothetical
means comes out non-positive, `Z` is 0 across the board — the honest
reading that the groups are not distinguishable from noise —
rather than a negative credibility.

## Solvency II aggregation

=== "Python"

    ```python
    sc.aggregate_scr({"mortality": 100, "lapse": 200, "expense": 80})
    sc.aggregate_scr(charges, corr=sc.SII_LIFE_CORR)     # the Annex IV matrix, exported
    sc.risk_margin([120, 100, 80, 55, 30], rate=0.04)    # cost-of-capital, 6 %
    ```

=== "R"

    ```r
    sc_aggregate_scr(c(mortality = 100, lapse = 200, expense = 80))
    sc_aggregate_scr(charges, corr = SC_SII_LIFE_CORR)
    sc_risk_margin(c(120, 100, 80, 55, 30), rate = 0.04)
    ```

`aggregate_scr` computes `SCR = √(vᵀρv)`, shows each module's Euler
marginal (they sum to the SCR) and the diversification credit. Modules
missing from the correlation matrix are treated as uncorrelated. The
standard-formula matrices ship in both languages: life (7×7, Annex IV),
non-life, and BSCR.

## Function list

`var` `tvar` (`es`) `aggregate_loss` `panjer` `simulate_losses`
`lognormal_params` `fit` `credibility` (`buhlmann`) `limited_fluctuation`
`full_credibility` `aggregate_scr` `risk_margin` · matrices
`SII_LIFE_CORR` `SII_NONLIFE_CORR` `SII_BSCR_CORR` — each with the `sc_`
twin (`SC_SII_*`) in R.
