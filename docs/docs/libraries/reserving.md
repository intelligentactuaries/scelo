# Reserving

From a long claims file to a defended IBNR: triangles with inferred
columns, four methods, Mack's full standard error, and an ODP bootstrap —
the same engine behind the IDE's reserving bridge, which reproduces the
published Mack (1993) RAA figures exactly.

## Triangles

=== "Python"

    ```python
    claims = sc.sample("claims")            # or sc.load("claims.csv")
    tri = sc.triangle(claims)               # origin × development, cumulative
    tri = sc.triangle(claims, origin="uw_year", value="paid")   # override inference
    tri = sc.from_wide(matrix, origins=range(1981, 1991))       # already-wide data
    sc.ata(tri)                             # age-to-age factors per origin + averages
    sc.latest_diagonal(tri)                 # paid to date per origin
    sc.to_incremental(tri); sc.to_cumulative(tri)
    ```

=== "R"

    ```r
    claims <- sc_sample("claims")
    tri <- sc_triangle(claims)
    tri <- sc_triangle(claims, origin = "uw_year", value = "paid")
    tri <- sc_from_wide(m, origins = 1981:1990)
    sc_ata(tri)
    sc_latest_diagonal(tri)
    sc_to_incremental(tri); sc_to_cumulative(tri)
    ```

```text
dev           0         1         2         3         4         5         6
origin
2018    68919.0   96350.0  178652.0  297389.0  396982.0  537291.0  560463.0
2019    39449.0   74979.0  131950.0  204479.0  320886.0  421532.0       NaN
...
— Cumulative triangle · paid by origin_year × development
  · 7 origin periods × 7 development lags, summed from 79 rows. Input rows treated
    as incremental amounts.
```

Input rows are incremental amounts by default (`incremental_input=False`
when your file is already cumulative). Development is indexed **purely by
period** — from a lag column, or as `payment − origin` when you give a
calendar `payment` column — never inferred from dates, so a truncated
parallelogram cannot grow phantom origins. Cells inside the observed
diagonal with no claims are 0; cells beyond it stay missing.

## The methods

=== "Python"

    ```python
    sc.chain_ladder(tri)                    # volume-weighted (or simple / regression)
    sc.mack(tri)                            # + Mack (1993) SE per origin and in total
    sc.bf(tri, premium=prem, elr=0.65)      # Bornhuetter–Ferguson
    sc.cape_cod(tri, premium=prem)          # ELR estimated from the triangle itself
    sc.bootstrap(tri, n=1000, seed=42)      # England–Verrall ODP, gamma process error
    sc.tail(sc.ldf(tri))                    # exponential-decay tail factor
    sc.reserve(claims)                      # all four side by side, from the raw file
    ```

=== "R"

    ```r
    sc_chain_ladder(tri)
    sc_mack(tri)
    sc_bf(tri, premium = prem, elr = 0.65)
    sc_cape_cod(tri, premium = prem)
    sc_bootstrap(tri, n = 1000, seed = 42)
    sc_tail(sc_ldf(tri))
    sc_reserve(claims)
    ```

```text
mack: IBNR 1,532,963 · ultimate 3,407,400 · latest 1,874,437 · SE 346,036 (CV 22.6%)
           latest       cdf  ...             se        cv
origin
2018     560463.0  1.000000  ...       0.000000       NaN
2019     421532.0  1.043127  ...    2082.253100  0.114538
...
total   1874437.0       NaN  ...  346036.429161  0.225730
— Mack chain ladder
  basis: volume-weighted link ratios · Mack (1993) MSE
  · SE is the square root of Mack's MSE: process + estimation error per origin, plus
    the inter-origin covariance in the total. ±1.96·SE is a normal-approximation
    interval, not a tail quantile.
```

Every method returns a **reserving result**: the per-origin Table plus
`ibnr`, `ultimate`, `latest`, `factors`, `cdf`, `se`, `cv` and a `detail`
dict of internals (per-origin MSE, sigmas, the bootstrap's simulated
totals). What the numbers mean:

- **Chain ladder** — volume-weighted link ratios by default (`average=`
  for simple or regression; `n_periods=` to use only recent diagonals;
  `tail_factor=` for a tail).
- **Mack** — the full 1993 MSE, including the inter-origin covariance
  term in the total, with Mack's own extrapolation for the last σ².
- **BF** — a-priori from, in order: your `apriori` (a scalar, a
  per-origin vector, or another result whose ultimates seed it),
  `premium × elr`, or the book-average chain-ladder ultimate (a flat ELR
  would cancel straight back to CL).
- **Cape Cod** — the ELR estimated as `Σ latest / Σ (premium / CDF)`,
  reported in `detail`.
- **Bootstrap** — over-dispersed Poisson (England–Verrall):
  bias-adjusted Pearson residuals resampled, each pseudo-triangle
  re-fitted, gamma process error on top. Seeded (`seed=42` by default),
  so a rerun reproduces exactly; `detail` carries the full simulated
  distribution and `p5 … p99`.

`reserve` runs the four in one line and stacks their summaries — the
table shown in the [quickstart](quickstart.md) — with the individual
results in its attributes.

## Checked against the literature

The test suites (Python and R both) reproduce Mack (1993) on the
published RAA triangle: IBNR **52,135**, ultimate **213,122**, total SE
**26,909** (CV 51.6 %), per-origin SEs `0, 206, 623, 747, 1469, 2002,
2209, 5358, 6333, 24566` — the same figures R's ChainLadder gives with
`est.sigma = "Mack"`. The `scelo[reserving]` extra installs the
`chainladder` package purely so you can run that cross-check yourself.

## Function list

`triangle` `from_wide` `is_cumulative` `to_incremental` `to_cumulative`
`latest_diagonal` `ata` `ldf` `cdf` `chain_ladder` `mack` `bf` `cape_cod`
`bootstrap` `tail` `reserve` — each with the `sc_` twin in R.
