# scelo for R

**Soft data → tools → hard data, in as few lines as it takes to be right.**

`scelo` is the Scelo IDE's brain layer as an R package: the same data
typing, cleaning rules, life tables, reserving engine and forecast model
the desktop workbench runs, for actuaries who would rather write three
lines than click through a workstation. Base R only.

```r
library(scelo)

df  <- sc_load("claims.csv")        # typed the way Scelo IDE types it
df  <- sc_clean(df)                 # the IDE's safe cleaning ops, audited
res <- sc_reserve(df)               # chain ladder, Mack, BF, ODP bootstrap
sc_report(res, to = "pack.html")    # a board pack: numbers that carry their basis
```

## Install

```r
# from the repository checkout
install.packages("packages/scelo-r", repos = NULL, type = "source")

# optional extras
install.packages(c("jsonlite", "curl"))   # the swarm client
install.packages("statmod")               # Tweedie GLMs
install.packages("reticulate")            # run lifelib models through Python
```

The package imports nothing beyond stats, utils and tools, so it installs
on the R that Scelo IDE bundles as it is.

## The idea

Every exported function starts with `sc_` (type it, let completion show
the map), takes a data frame first, infers the columns it needs from their
names (`accident_year`, `AY`, `origin` all mean origin), and returns a
**scelo_table**: a data.frame that also carries

- `title`: what it is,
- `basis`: one line of provenance,
- `notes`: the things an actuary should know before trusting it,
- `provenance`: a content hash, timestamp and audit trail once you `sc_hard()` it.

Print one and the notes print under it. Subset it, merge it, plot it: it is
still a data.frame. `sc_df(x)` gives the plain frame back.

```r
> sc_life_table()[1:3, ]
  age           qx        px        lx       dx       Lx      Tx       ex
1  20 0.0002496390 0.9997504 100000.00 24.96390 99987.52 6591309 65.91309
2  21 0.0002533172 0.9997467  99975.04 25.32540 99962.37 6491321 64.92942
3  22 0.0002574515 0.9997425  99949.71 25.73220 99936.84 6391359 63.94575
— Life table · Gompertz–Makeham (illustrative)
  basis: Gompertz–Makeham (illustrative)
  · Mortality is Scelo's ILLUSTRATIVE Gompertz–Makeham basis (A = 0.00022, B = 2.7e-6, c = 1.124),
    not a published standard table: swap in your own qx column or parameters before relying on the figures.
  · Radix l(20) = 100,000; table closed at age 110 (qx set to 1). Lx uses the uniform-deaths approximation lx − ½dx.
```

## Sixty-second tour

```r
library(scelo)

# ── soft data ────────────────────────────────────────────────────────────
df <- sc_sample("dirty")           # the IDE's messy-intake demo (or sc_load("file.csv"))
sc_profile(df)                     # type, missing, unique, five-number summary, fences, top values
sc_describe(df)                    # Bessel sd, type-7 quantiles, G1/G2 shape, Jarque-Bera, ranked by CV
sc_tab(df, "Region")               # Stata's tab
sc_suggest(df)                     # the cleaning plan with evidence
clean <- sc_clean(df)              # the 9 safe ops
clean <- sc_clean(df, "all")       # + dedupe, drop empty/constant, impute, cap outliers, snake_case
sc_combine(a, b)                   # append or join-left, decided from the schemas and keys

# ── life ─────────────────────────────────────────────────────────────────
sc_life_table(qx_df)               # from any basis (qx / lx / deaths + exposure / Makeham)
sc_commutation(i = 0.04)           # Dx Nx Cx Mx Rx Sx
sc_factors(i = 0.04, n = 10)       # äx ax Ax äx:n A¹x:n nEx Ax:n
sc_premium(i = 0.04, product = "term")
sc_ae(experience_df); sc_graduate(crude_qx, h = 100); sc_lee_carter(rates_df); sc_kaplan_meier(df); sc_basicterm(mp)
sc_scr_life(mp); sc_csm(mp, ra = 0.05)                       # standard-formula SCR and IFRS 17 CSM on the projection
sc_lifelib_run("basiclife", "BasicTerm_ME", mp)               # the real lifelib model through reticulate

# ── reserving ────────────────────────────────────────────────────────────
tri <- sc_triangle(claims)
sc_chain_ladder(tri); sc_mack(tri); sc_bf(tri); sc_cape_cod(tri, premium); sc_bootstrap(tri, n = 1000)
sc_reserve(claims)

# ── finance & risk ──────────────────────────────────────────────────────
sc_discount_curve(c(`1` = .03, `5` = .04, `10` = .05)); sc_smith_wilson(tenors, rates, ufr = .042)
sc_pv(cf, .05); sc_irr(cf); sc_annuity_certain(10, .05, due = TRUE); sc_duration(cf, .05)
sc_aggregate_loss("poisson", "lognormal", lam = 5, mu = 8, sigma = 1)
sc_fit(losses); sc_var(x, .995); sc_tvar(x, .995)
sc_credibility(df, "group", "loss_ratio"); sc_aggregate_scr(c(mortality = 100, lapse = 200))

# ── pricing & fairness ──────────────────────────────────────────────────
m <- sc_glm(df, "claims ~ C(region) + age", "poisson", offset = "exposure")
sc_relativities(m); sc_predict(m, new); sc_lift(y, m$fitted)
sc_fairness(df, "y", "score", "group"); sc_fairness_audit(df, "score", "protected", "age")

# ── forecast & swarm ────────────────────────────────────────────────────
sc_wmtr("pension scheme with a weakening sponsor covenant")   # same numbers as the IDE
sc_council("…scenario…", subset = 32)                          # needs the swarm (Scelo IDE / bun run dev:swarm)
sc_society("…scenario…", size = 200)

# ── charts (base graphics, no extra package) ────────────────────────────
sc_plot_rates(df, "country", "lapsed", exposure = "exposure")  # rate by group, 95 % intervals
sc_plot_relativities(m); sc_plot_projection(bt); sc_plot_scr(scr); sc_plot_csm(csm); sc_plot_triangle(tri)

# ── hard data ───────────────────────────────────────────────────────────
t <- sc_hard(sc_mack(tri)$table, assumptions = list(tail = 1))
sc_report(t, sc_life_table(), to = "pack.html")
sc_audit()
```

`sc_cheatsheet()` prints the one-screen version. Pipes read naturally:
`df |> sc_clean() |> sc_triangle() |> sc_mack()`.

## Parity

The R package is tested against numbers produced by the Python package
(`tests/testthat/fixtures/py_golden.json`) and against the TypeScript
WMTR engine's fixture: the two libraries and the IDE agree on life tables,
commutation functions, reserves, curves, aggregate-loss quantiles, GLM
coefficients, cleaning plans and forecasts.

```r
# run the tests from the package directory
Rscript dev/run-tests.R
```

## License

Scelo IDE Source-Available License v1.1 (`LicenseRef-Scelo-IDE-1.1`), the
same license as the IDE. See `LICENSE`. (CRAN requires an open-source
license; this package is distributed from the repository.)

Intelligent Actuaries (Pty) Ltd · scelo@intelligentactuaries.com
