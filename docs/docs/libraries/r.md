# scelo for R

```r
# from the repository checkout
install.packages("packages/scelo-r", repos = NULL, type = "source")
library(scelo)
```

The package lives at
[`packages/scelo-r`](https://github.com/intelligentactuaries/scelo/tree/main/packages/scelo-r)
and depends on base R only (stats, utils, tools); `jsonlite` and `curl` are
needed for the swarm client, `statmod` for Tweedie GLMs, `reticulate` for
running lifelib models. It runs on the R the IDE bundles.

Every exported function starts with `sc_`: type `sc_` and let completion
show the map, the R analogue of `sc.` in Python.

## A scelo_table

Every table-shaped result is a `scelo_table`: a data.frame with attributes
`title`, `basis`, `notes` and (after `sc_hard()`) `provenance`. Printing
shows the frame and then the notes; `sc_notes(x)`, `sc_basis(x)` read them;
`sc_df(x)` gives the plain data.frame; subsetting keeps them.

```r
> sc_factors(i = 0.04, n = 10)[1:2, ]
  age       äx       ax         Ax    äx:10      A¹x:10      10Ex     Ax:10
1  20 23.79502 22.79502 0.08480678 8.426126 0.002196392 0.6737218 0.6759182
2  21 23.71274 22.71274 0.08797137 8.425946 0.002247692 0.6736775 0.6759252
— Annuity & assurance factors · Gompertz–Makeham (illustrative) · i = 4 % · n = 10
  basis: Gompertz–Makeham (illustrative) · i = 4 %
  · Mortality is Scelo's ILLUSTRATIVE Gompertz–Makeham basis ...
```

## The map

```text
SOFT    sc_load("x.csv")   sc_profile(df)   sc_describe(df)   sc_tab(df, "line")
        sc_suggest(df)     sc_clean(df)     sc_clean(df, "all")   sc_combine(a, b)
LIFE    sc_life_table()  sc_commutation(i = .04)  sc_factors(i = .04, n = 10)  sc_premium()
        sc_ae(df)  sc_graduate(qx)  sc_lee_carter(df)  sc_kaplan_meier(df)  sc_basicterm(mp)
RESERVE sc_triangle(df)  sc_chain_ladder(tri)  sc_mack(tri)  sc_bf(tri)  sc_bootstrap(tri)  sc_reserve(df)
FINANCE sc_discount_curve(.04)  sc_smith_wilson(t, r)  sc_pv(cf, .05)  sc_irr(cf)  sc_annuity_certain(10, .05)
RISK    sc_var(x)  sc_tvar(x)  sc_aggregate_loss("poisson", "lognormal", lam = 5, mu = 8, sigma = 1)  sc_fit(x)
        sc_credibility(df, "group", "lr")  sc_aggregate_scr(c(mortality = 100, lapse = 200))
PRICING sc_glm(df, "claims ~ C(region) + age", "poisson", offset = "exposure") |> sc_relativities()
        sc_freq_sev(df, "region")  sc_loss_ratio(df, "line")  sc_lift(y, pred)
FAIR    sc_fairness(df, "y", "score", "group")  sc_fairness_audit(df, "score", "prot", "age")
CLIMATE sc_ensemble(df, "t2m")  sc_return_period(x)  sc_parametric_trigger(x)
FORECAST sc_wmtr("pension scheme, weakening covenant")  sc_sensitivity(...)
SWARM   sc_council("...")  sc_society("...")  sc_augment(df, "...")   (needs Scelo IDE or bun run dev:swarm)
HARD    sc_hard(t)  sc_report(t1, t2, to = "pack.html")  sc_export(t, "out.csv")  sc_audit()  sc_verify(t)
```

Pipes read naturally: `df |> sc_clean() |> sc_triangle() |> sc_mack()`.

## Tested against the Python package

The R test suite reads `tests/testthat/fixtures/py_golden.json`, values
computed by the Python package, and checks life tables, commutation
functions, factors, premiums, the RAA Mack table, discount curves, Smith-
Wilson, Panjer, credibility, GLM coefficients, the cleaning plan for the
dirty sample and more to 1e-9; the WMTR engine is checked against the same
TypeScript fixture the Python package uses.
